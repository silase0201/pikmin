/**
 * Overpass API 查詢與 S2 Level 17 網格聚類運算模組
 * 具備多伺服器容錯切換、快取檢查與 S2 純種區判定
 */

import { S2 } from './lib/s2geometry.js';
import { getDecorRule } from './decor-rules.js';
import { getCachedPOIs, setCachedPOIs, buildCacheKey } from './cache.js';

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

let currentServerIndex = 0;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 最少間隔 1 秒

/**
 * 依據中心座標與半徑公尺計算 Bounding Box [south, west, north, east]
 */
export function calculateBoundingBox(lat, lng, radiusMeters) {
  const earthRadius = 6378137; // 公尺
  const dLat = (radiusMeters / earthRadius) * (180 / Math.PI);
  const dLng = (radiusMeters / (earthRadius * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);

  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
  };
}

/**
 * 計算兩點間的 Haversine 距離（公尺）
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半徑 (公尺)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * 建立 Overpass QL 查詢字串
 */
function buildOverpassQuery(bbox, selectedRules) {
  const bboxStr = `${bbox.south.toFixed(5)},${bbox.west.toFixed(5)},${bbox.north.toFixed(5)},${bbox.east.toFixed(5)}`;
  const statements = [];

  for (const rule of selectedRules) {
    for (const tag of rule.tags) {
      const [k, v] = tag.split('=');
      if (k && v) {
        statements.push(`  node["${k}"="${v}"](${bboxStr});`);
        statements.push(`  way["${k}"="${v}"](${bboxStr});`);
      }
    }
  }

  if (statements.length === 0) return '';

  return `
[out:json][timeout:30];
(
${statements.join('\n')}
);
out center;
`.trim();
}

/**
 * 執行 Overpass API 查詢（支援重試、切換伺服器與快取）
 */
export async function fetchDecorPOIs({
  lat,
  lng,
  radiusMeters,
  selectedRules,
  abortSignal,
  onProgress,
}) {
  if (!selectedRules || selectedRules.length === 0) {
    return { pois: [], cells: [] };
  }

  const selectedDecorIds = selectedRules.map(r => r.id);
  const cacheKey = buildCacheKey(lat, lng, radiusMeters, selectedDecorIds);

  // 1. 先查本機快取
  const cached = await getCachedPOIs(cacheKey);
  if (cached) {
    if (onProgress) onProgress({ status: 'cached', message: '已從本機快取讀取（0ms）' });
    return processPOIsAndS2Cells(cached, lat, lng, selectedRules);
  }

  const bbox = calculateBoundingBox(lat, lng, radiusMeters);
  const query = buildOverpassQuery(bbox, selectedRules);
  if (!query) return { pois: [], cells: [] };

  // 2. 頻率控制防呆
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - timeSinceLast));
  }
  lastRequestTime = Date.now();

  let lastError = null;
  const maxAttempts = OVERPASS_SERVERS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal && abortSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const serverUrl = OVERPASS_SERVERS[(currentServerIndex + attempt) % OVERPASS_SERVERS.length];

    if (onProgress) {
      onProgress({
        status: 'fetching',
        server: serverUrl,
        attempt: attempt + 1,
        message: `正在向 OSM 節點查詢資料 (${attempt + 1}/${maxAttempts})...`,
      });
    }

    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: abortSignal,
      });

      if (response.status === 429) {
        console.warn(`[Overpass] Server ${serverUrl} rate limited (429), trying next server...`);
        currentServerIndex = (currentServerIndex + 1) % OVERPASS_SERVERS.length;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const rawElements = json.elements || [];

      // 寫入本機快取
      await setCachedPOIs(cacheKey, rawElements);

      return processPOIsAndS2Cells(rawElements, lat, lng, selectedRules);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      console.warn(`[Overpass] Error querying ${serverUrl}:`, err);
    }
  }

  throw lastError || new Error('所有 Overpass 伺服器均暫時無回應，請稍候重試');
}

/**
 * 將原始 OSM 元素轉為 POI 點位並聚合至 S2 Level 17 網格
 */
export function processPOIsAndS2Cells(elements, userLat, userLng, selectedRules) {
  const ruleMap = new Map(selectedRules.map(r => [r.id, r]));
  const pois = [];
  const cellMap = new Map(); // S2 Cell Key -> Cell Object

  for (const el of elements) {
    if (!el.tags) continue;

    let pLat = el.lat;
    let pLon = el.lon;
    if (pLat === undefined && el.center) {
      pLat = el.center.lat;
      pLon = el.center.lon;
    }
    if (pLat === undefined || pLon === undefined) continue;

    // 判斷相符的飾品規則
    let matchedRule = null;
    for (const rule of selectedRules) {
      for (const tag of rule.tags) {
        const [k, v] = tag.split('=');
        if (el.tags[k] === v) {
          matchedRule = rule;
          break;
        }
      }
      if (matchedRule) break;
    }

    if (!matchedRule) continue;

    // 提取名稱
    const name =
      el.tags.name ||
      el.tags['name:zh'] ||
      el.tags['name:zh-TW'] ||
      el.tags['name:en'] ||
      `未命名 ${matchedRule.name}`;

    const dist = calculateHaversineDistance(userLat, userLng, pLat, pLon);

    // 計算該 POI 所在的 S2 Level 17 網格 Key
    let cellKey = '';
    try {
      cellKey = S2.latLngToKey(pLat, pLon, 17);
    } catch (e) {
      cellKey = `${pLat.toFixed(4)},${pLon.toFixed(4)}`;
    }

    const poi = {
      id: `${el.type}-${el.id}`,
      name,
      decorType: matchedRule.id,
      decorName: matchedRule.name,
      decorSymbol: matchedRule.symbol,
      decorColor: matchedRule.color,
      decorGroup: matchedRule.group,
      lat: pLat,
      lng: pLon,
      distance: dist,
      cellKey,
    };

    pois.push(poi);

    // 歸納到 S2 網格
    if (!cellMap.has(cellKey)) {
      let center = { lat: pLat, lng: pLon };
      let corners = [];
      try {
        center = S2.keyToLatLng(cellKey);
        corners = S2.S2Cell.FromHilbertQuadKey(cellKey).getCornerLatLngs();
      } catch (e) {
        // fallback
        center = { lat: pLat, lng: pLon };
      }

      cellMap.set(cellKey, {
        cellKey,
        center,
        corners,
        distance: calculateHaversineDistance(userLat, userLng, center.lat, center.lng),
        pois: [],
        decorTypes: new Set(),
      });
    }

    const cellObj = cellMap.get(cellKey);
    cellObj.pois.push(poi);
    cellObj.decorTypes.add(matchedRule.id);
  }

  // 轉為 Cell 清單並標註純種區資訊
  const cells = Array.from(cellMap.values()).map(cell => {
    const typeCount = cell.decorTypes.size;
    const isPure = (typeCount === 1);
    const decorList = Array.from(cell.decorTypes).map(id => getDecorRule(id)).filter(Boolean);

    return {
      ...cell,
      typeCount,
      isPure,
      decorList,
      // 純種優先等級: 1種 (純種) > 2-3種 (輕度混雜) > 4種以上 (高度混雜)
      purityLabel: isPure ? '純種區 (100%)' : (typeCount <= 3 ? `混雜 (${typeCount}種)` : `高混雜 (${typeCount}種)`),
    };
  });

  return { pois, cells };
}
