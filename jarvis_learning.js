'use strict';

/**
 * JARVIS LEARNING SYSTEM
 * 
 * Livelli di apprendimento:
 * 1. PATTERN RECOGNITION - Riconosce pattern nelle azioni
 * 2. HABIT LEARNING - Impara abitudini ricorrenti
 * 3. CONTEXT AWARENESS - Capisce contesto (ora, giorno, app aperte)
 * 4. PREDICTIVE - Prevede cosa vuoi fare
 * 5. REASONING - Ragiona sulle informazioni
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory_store');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

let _learningDb = null;
let _learningDbPath = null;

// =====================================================
// INITIALIZATION
// =====================================================

function init(dbPath) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite not available');
  }
  if (!dbPath) {
    throw new Error('init(dbPath): dbPath required');
  }

  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  _learningDb = new DatabaseSync(dbPath);
  _learningDbPath = dbPath;

  // Pragmas
  _learningDb.exec('PRAGMA journal_mode=WAL;');
  _learningDb.exec('PRAGMA synchronous=NORMAL;');
  _learningDb.exec('PRAGMA foreign_keys=ON;');

  // ===== TABELLE LEARNING =====

  // 1. PATTERNS - Pattern ricorrenti riconosciuti
  _learningDb.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,  -- 'command', 'workflow', 'context'
      pattern_key TEXT NOT NULL,   -- identificatore pattern
      frequency INTEGER DEFAULT 1, -- quante volte visto
      confidence REAL DEFAULT 0.5, -- quanto siamo sicuri (0-1)
      context_json TEXT,           -- contesto (ora, giorno, app aperte)
      actions_json TEXT,           -- azioni associate
      last_seen INTEGER,           -- timestamp ultima volta
      created_at INTEGER,
      UNIQUE(pattern_type, pattern_key)
    );
  `);

  // 2. HABITS - Abitudini dell'utente
  _learningDb.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_name TEXT NOT NULL UNIQUE,
      description TEXT,
      trigger_context TEXT,        -- quando scatta (es: "lunedì mattina 9:00")
      expected_action TEXT,        -- cosa ti aspetti che l'utente faccia
      confidence REAL DEFAULT 0.5,
      occurrences INTEGER DEFAULT 1,
      last_occurred INTEGER,
      created_at INTEGER
    );
  `);

  // 3. CONCEPTS - Concetti semantici appresi
  _learningDb.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_name TEXT NOT NULL UNIQUE,
      category TEXT,               -- 'person', 'place', 'thing', 'action'
      attributes_json TEXT,        -- attributi (es: {"role": "collega", "team": "dev"})
      relations_json TEXT,         -- relazioni con altri concetti
      confidence REAL DEFAULT 0.5,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);

  // 4. ACTIONS_LOG - Log azioni utente (per learning)
  _learningDb.exec(`
    CREATE TABLE IF NOT EXISTS actions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      action_type TEXT NOT NULL,   -- 'open_app', 'file_op', 'command', 'search'
      action_data TEXT,            -- JSON con dettagli
      context_json TEXT,           -- contesto al momento dell'azione
      outcome TEXT,                -- 'success', 'failed', 'partial'
      user_feedback TEXT           -- feedback esplicito utente (se presente)
    );
  `);
  _learningDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_actions_type ON actions_log(action_type);
  `);

  // 5. REASONING_CACHE - Cache ragionamenti (evita ricalcoli)
  _learningDb.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT NOT NULL UNIQUE,
      reasoning_result TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      created_at INTEGER,
      expires_at INTEGER
    );
  `);

  console.log('[LEARNING] Database initialized:', _learningDbPath);
  return true;
}

// =====================================================
// CONTEXT EXTRACTION
// =====================================================

function getCurrentContext() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    hour: now.getHours(),
    dayOfWeek: now.getDay(), // 0=Sunday, 1=Monday, ...
    dayOfMonth: now.getDate(),
    month: now.getMonth(),
    isWeekend: (now.getDay() === 0 || now.getDay() === 6),
    timeOfDay: getTimeOfDay(now.getHours()),
    // Questi verranno popolati da sensori esterni:
    activeApp: null,
    openWindows: [],
    userPresent: true,
    userAttention: 'focused' // 'focused', 'away', 'idle'
  };
}

function getTimeOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

// =====================================================
// PATTERN RECOGNITION
// =====================================================

function recordPattern(patternType, patternKey, actions, context) {
  if (!_learningDb) return false;

  const ctx = context || getCurrentContext();
  const now = Date.now();

  try {
    const existing = _learningDb.prepare(`
      SELECT id, frequency, confidence FROM patterns 
      WHERE pattern_type = ? AND pattern_key = ?
    `).get(patternType, patternKey);

    if (existing) {
      // Pattern già visto -> incrementa frequenza e confidence
      const newFreq = existing.frequency + 1;
      const newConf = Math.min(0.95, existing.confidence + 0.05);

      _learningDb.prepare(`
        UPDATE patterns 
        SET frequency = ?, confidence = ?, last_seen = ?, 
            context_json = ?, actions_json = ?
        WHERE id = ?
      `).run(newFreq, newConf, now, 
             JSON.stringify(ctx), 
             JSON.stringify(actions), 
             existing.id);

      console.log(`[LEARNING] Pattern reinforced: ${patternType}/${patternKey} (freq=${newFreq}, conf=${newConf.toFixed(2)})`);
    } else {
      // Nuovo pattern
      _learningDb.prepare(`
        INSERT INTO patterns 
        (pattern_type, pattern_key, frequency, confidence, context_json, actions_json, last_seen, created_at)
        VALUES (?, ?, 1, 0.5, ?, ?, ?, ?)
      `).run(patternType, patternKey, 
             JSON.stringify(ctx), 
             JSON.stringify(actions), 
             now, now);

      console.log(`[LEARNING] New pattern learned: ${patternType}/${patternKey}`);
    }

    return true;
  } catch (e) {
    console.error('[LEARNING] recordPattern error:', e.message);
    return false;
  }
}

function getPatterns(patternType, minConfidence = 0.6) {
  if (!_learningDb) return [];

  try {
    const rows = _learningDb.prepare(`
      SELECT * FROM patterns 
      WHERE pattern_type = ? AND confidence >= ?
      ORDER BY frequency DESC, confidence DESC
      LIMIT 20
    `).all(patternType, minConfidence);

    return rows.map(r => ({
      id: r.id,
      type: r.pattern_type,
      key: r.pattern_key,
      frequency: r.frequency,
      confidence: r.confidence,
      context: safeParseJSON(r.context_json),
      actions: safeParseJSON(r.actions_json),
      lastSeen: r.last_seen
    }));
  } catch (e) {
    console.error('[LEARNING] getPatterns error:', e.message);
    return [];
  }
}

// =====================================================
// HABIT LEARNING
// =====================================================

function recordHabit(habitName, triggerContext, expectedAction) {
  if (!_learningDb) return false;

  const now = Date.now();

  try {
    const existing = _learningDb.prepare(`
      SELECT id, occurrences, confidence FROM habits WHERE habit_name = ?
    `).get(habitName);

    if (existing) {
      const newOcc = existing.occurrences + 1;
      const newConf = Math.min(0.95, existing.confidence + 0.03);

      _learningDb.prepare(`
        UPDATE habits 
        SET occurrences = ?, confidence = ?, last_occurred = ?,
            trigger_context = ?, expected_action = ?
        WHERE id = ?
      `).run(newOcc, newConf, now, triggerContext, expectedAction, existing.id);

      console.log(`[LEARNING] Habit reinforced: ${habitName} (occ=${newOcc}, conf=${newConf.toFixed(2)})`);
    } else {
      _learningDb.prepare(`
        INSERT INTO habits 
        (habit_name, trigger_context, expected_action, confidence, occurrences, last_occurred, created_at)
        VALUES (?, ?, ?, 0.5, 1, ?, ?)
      `).run(habitName, triggerContext, expectedAction, now, now);

      console.log(`[LEARNING] New habit learned: ${habitName}`);
    }

    return true;
  } catch (e) {
    console.error('[LEARNING] recordHabit error:', e.message);
    return false;
  }
}

function predictNextAction(context) {
  if (!_learningDb) return null;

  const ctx = context || getCurrentContext();

  try {
    // Cerca abitudini che matchano il contesto attuale
    const habits = _learningDb.prepare(`
      SELECT * FROM habits 
      WHERE confidence >= 0.7
      ORDER BY confidence DESC, occurrences DESC
      LIMIT 5
    `).all();

    for (const habit of habits) {
      // Match contesto (semplificato - può essere molto più sofisticato)
      const trigger = String(habit.trigger_context || '').toLowerCase();
      const timeOfDay = ctx.timeOfDay || '';
      
      if (trigger.includes(timeOfDay) || trigger.includes('sempre')) {
        return {
          habitName: habit.habit_name,
          expectedAction: habit.expected_action,
          confidence: habit.confidence,
          suggestion: `Basandomi sulle tue abitudini, di solito a quest'ora ${habit.expected_action}`
        };
      }
    }

    return null;
  } catch (e) {
    console.error('[LEARNING] predictNextAction error:', e.message);
    return null;
  }
}

// =====================================================
// CONCEPT LEARNING (Semantic Memory)
// =====================================================

function learnConcept(conceptName, category, attributes, relations) {
  if (!_learningDb) return false;

  const now = Date.now();

  try {
    const existing = _learningDb.prepare(`
      SELECT id, confidence FROM concepts WHERE concept_name = ?
    `).get(conceptName);

    if (existing) {
      // Aggiorna concetto esistente
      const newConf = Math.min(0.95, existing.confidence + 0.05);

      _learningDb.prepare(`
        UPDATE concepts 
        SET category = ?, attributes_json = ?, relations_json = ?,
            confidence = ?, updated_at = ?
        WHERE id = ?
      `).run(category, 
             JSON.stringify(attributes), 
             JSON.stringify(relations), 
             newConf, now, existing.id);

      console.log(`[LEARNING] Concept updated: ${conceptName}`);
    } else {
      // Nuovo concetto
      _learningDb.prepare(`
        INSERT INTO concepts 
        (concept_name, category, attributes_json, relations_json, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0.7, ?, ?)
      `).run(conceptName, category, 
             JSON.stringify(attributes), 
             JSON.stringify(relations), 
             now, now);

      console.log(`[LEARNING] New concept learned: ${conceptName}`);
    }

    return true;
  } catch (e) {
    console.error('[LEARNING] learnConcept error:', e.message);
    return false;
  }
}

function getConcept(conceptName) {
  if (!_learningDb) return null;

  try {
    const row = _learningDb.prepare(`
      SELECT * FROM concepts WHERE concept_name = ?
    `).get(conceptName);

    if (!row) return null;

    return {
      name: row.concept_name,
      category: row.category,
      attributes: safeParseJSON(row.attributes_json),
      relations: safeParseJSON(row.relations_json),
      confidence: row.confidence
    };
  } catch (e) {
    console.error('[LEARNING] getConcept error:', e.message);
    return null;
  }
}

// =====================================================
// ACTION LOGGING
// =====================================================

function logAction(actionType, actionData, context, outcome, userFeedback) {
  if (!_learningDb) return false;

  const ctx = context || getCurrentContext();
  const now = Date.now();

  try {
    _learningDb.prepare(`
      INSERT INTO actions_log 
      (timestamp, action_type, action_data, context_json, outcome, user_feedback)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(now, actionType, 
           JSON.stringify(actionData), 
           JSON.stringify(ctx), 
           outcome || 'success', 
           userFeedback || null);

    // Auto-learning: cerca pattern nelle azioni recenti
    analyzeRecentActions(actionType);

    return true;
  } catch (e) {
    console.error('[LEARNING] logAction error:', e.message);
    return false;
  }
}

function analyzeRecentActions(actionType) {
  if (!_learningDb) return;

  try {
    // Prendi ultime 10 azioni di questo tipo
    const recent = _learningDb.prepare(`
      SELECT * FROM actions_log 
      WHERE action_type = ? 
      ORDER BY timestamp DESC 
      LIMIT 10
    `).all(actionType);

    if (recent.length >= 3) {
      // Cerca pattern temporali
      const contexts = recent.map(r => safeParseJSON(r.context_json));
      const timeOfDayFreq = {};

      contexts.forEach(ctx => {
        const tod = ctx.timeOfDay || 'unknown';
        timeOfDayFreq[tod] = (timeOfDayFreq[tod] || 0) + 1;
      });

      // Se un'azione si ripete sempre in un momento specifico -> habit
      const mostCommonTime = Object.keys(timeOfDayFreq)
        .reduce((a, b) => timeOfDayFreq[a] > timeOfDayFreq[b] ? a : b);

      if (timeOfDayFreq[mostCommonTime] >= 3) {
        const habitName = `${actionType}_${mostCommonTime}`;
        recordHabit(
          habitName,
          `${mostCommonTime}`,
          `eseguire ${actionType}`
        );
      }
    }
  } catch (e) {
    console.error('[LEARNING] analyzeRecentActions error:', e.message);
  }
}

// =====================================================
// REASONING ENGINE
// =====================================================

function reason(query, memoryContext) {
  /**
   * Reasoning engine - combina:
   * - Short-term memory (conversazione corrente)
   * - Long-term memory (memory_store)
   * - Learned patterns
   * - Habits
   * - Concepts
   * 
   * Restituisce: deduzione/suggerimento basato su tutto ciò che sa
   */

  if (!_learningDb) return { reasoning: '', confidence: 0 };

  const queryLower = String(query || '').toLowerCase();
  const hash = simpleHash(queryLower);

  // Check cache
  try {
    const cached = _learningDb.prepare(`
      SELECT reasoning_result, confidence FROM reasoning_cache 
      WHERE query_hash = ? AND expires_at > ?
    `).get(hash, Date.now());

    if (cached) {
      return {
        reasoning: cached.reasoning_result,
        confidence: cached.confidence,
        cached: true
      };
    }
  } catch (_) {}

  // Reasoning completo
  let reasoning = '';
  let confidence = 0.5;

  try {
    // 1. Cerca pattern rilevanti
    const relevantPatterns = getPatterns('command', 0.6)
      .filter(p => queryLower.includes(p.key.toLowerCase()));

    if (relevantPatterns.length > 0) {
      reasoning += `Ho notato che di solito quando chiedi "${query}", esegui queste azioni: `;
      reasoning += relevantPatterns.map(p => p.actions.join(', ')).join('; ');
      reasoning += '. ';
      confidence += 0.2;
    }

    // 2. Cerca abitudini correlate
    const prediction = predictNextAction();
    if (prediction) {
      reasoning += `${prediction.suggestion}. `;
      confidence += 0.15;
    }

    // 3. Cerca concetti menzionati
    const words = queryLower.split(/\s+/);
    for (const word of words) {
      const concept = getConcept(word);
      if (concept) {
        reasoning += `So che "${word}" è ${concept.category}`;
        if (concept.attributes && Object.keys(concept.attributes).length > 0) {
          reasoning += ` con queste caratteristiche: ${JSON.stringify(concept.attributes)}`;
        }
        reasoning += '. ';
        confidence += 0.1;
      }
    }

    // 4. Memoria conversazioni (usa memory_store esistente)
    if (memory && typeof memory.search === 'function') {
      try {
        const memHits = memory.search(query, 3);
        if (memHits && memHits.length > 0) {
          reasoning += `Ricordo che abbiamo parlato di questo in passato. `;
          confidence += 0.15;
        }
      } catch (_) {}
    }

    confidence = Math.min(0.95, confidence);

    // Cache result
    if (reasoning) {
      const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24h
      _learningDb.prepare(`
        INSERT OR REPLACE INTO reasoning_cache 
        (query_hash, reasoning_result, confidence, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(hash, reasoning, confidence, Date.now(), expiresAt);
    }

    return { reasoning, confidence };

  } catch (e) {
    console.error('[LEARNING] reason error:', e.message);
    return { reasoning: '', confidence: 0 };
  }
}

// =====================================================
// UTILITIES
// =====================================================

function safeParseJSON(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

function getStats() {
  if (!_learningDb) return null;

  try {
    const patterns = _learningDb.prepare('SELECT COUNT(*) as c FROM patterns').get();
    const habits = _learningDb.prepare('SELECT COUNT(*) as c FROM habits').get();
    const concepts = _learningDb.prepare('SELECT COUNT(*) as c FROM concepts').get();
    const actions = _learningDb.prepare('SELECT COUNT(*) as c FROM actions_log').get();

    return {
      patterns: patterns.c,
      habits: habits.c,
      concepts: concepts.c,
      actionsLogged: actions.c,
      dbPath: _learningDbPath
    };
  } catch (e) {
    console.error('[LEARNING] getStats error:', e.message);
    return null;
  }
}

function close() {
  if (_learningDb) {
    try { _learningDb.close(); } catch (_) {}
  }
  _learningDb = null;
  _learningDbPath = null;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Init
  init,
  close,
  getStats,
  
  // Context
  getCurrentContext,
  
  // Pattern learning
  recordPattern,
  getPatterns,
  
  // Habit learning
  recordHabit,
  predictNextAction,
  
  // Concept learning
  learnConcept,
  getConcept,
  
  // Action logging
  logAction,
  
  // Reasoning
  reason
};
