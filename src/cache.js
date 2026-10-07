/**
 * 輕量本機快取與設定存儲模組 (IndexedDB + localStorage 雙重容錯)
 * 用於實作 Local-First 與 0ms 二次讀取
 */

const DB_NAME = 'pikmin_decor_cache_db';
const DB_VERSION = 1;
const STORE_NAME = 'query_cache';
const SETTINGS_KEY = 'pikmin_user_settings_v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小時快取

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      return resolve(null);
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (err) => {
      console.warn('[Cache] IndexedDB open error:', err);
      resolve(null);
    };
  });

  return dbPromise;
}

/**
 * 建立快取鍵（依據中心經緯度四捨五入與搜尋半徑）
 */
export function buildCacheKey(lat, lng, radiusMeters, selectedDecorIds) {
  // 將經緯度精確到約 50-100 公尺 (小數點後 3 位)
  const latKey = Number(lat).toFixed(3);
  const lngKey = Number(lng).toFixed(3);
  const decorHash = selectedDecorIds.slice().sort().join(',');
  return `q_${latKey}_${lngKey}_${radiusMeters}_${decorHash.length}`;
}

/**
 * 讀取快取資料
 */
export async function getCachedPOIs(cacheKey) {
  try {
    const db = await openDB();
    if (!db) {
      if (typeof localStorage === 'undefined') return null;
      const item = localStorage.getItem('cache_' + cacheKey);
      if (!item) return null;
      const parsed = JSON.parse(item);
      if (Date.now() - parsed.timestamp > CACHE_TTL_MS) {
        localStorage.removeItem('cache_' + cacheKey);
        return null;
      }
      return parsed.data;
    }

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cacheKey);

      req.onsuccess = () => {
        const result = req.result;
        if (!result) return resolve(null);
        if (Date.now() - result.timestamp > CACHE_TTL_MS) {
          // 過期清除
          deleteCachedKey(cacheKey);
          return resolve(null);
        }
        resolve(result.data);
      };

      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('[Cache] Read error:', err);
    return null;
  }
}

const DECOR_FILTER_KEY = 'pikmin_decor_filter_selection_v2';


function clearOldLocalCache() {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('cache_')) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('[Cache] Cleanup error:', e);
  }
}

/**
 * 寫入快取資料
 */
export async function setCachedPOIs(cacheKey, data) {
  try {
    const payload = {
      key: cacheKey,
      data,
      timestamp: Date.now(),
    };

    const db = await openDB();
    if (!db) {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('cache_' + cacheKey, JSON.stringify(payload));
        } catch (e) {
          clearOldLocalCache();
        }
      }
      return;
    }

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(payload);
  } catch (err) {
    console.warn('[Cache] Write error:', err);
  }
}

export async function deleteCachedKey(key) {
  try {
    const db = await openDB();
    if (db) {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
    }
    localStorage.removeItem('cache_' + key);
  } catch (e) { }
}

/**
 * 飾品篩選選擇持久化（獨立存儲鍵，避免被快取清除影響）
 */
export function loadDecorFilter() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(DECOR_FILTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

export function saveDecorFilter(decorIds) {
  if (typeof localStorage === 'undefined') return;
  try {
    const arr = Array.isArray(decorIds) ? decorIds : Array.from(decorIds);
    localStorage.setItem(DECOR_FILTER_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn('[DecorFilter] Save error:', err);
  }
}

/**
 * 使用者偏好設定持久化
 */
export function loadUserSettings(defaultSettings) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch (err) {
    return defaultSettings;
  }
}

export function saveUserSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[Settings] Save error:', err);
  }
}

