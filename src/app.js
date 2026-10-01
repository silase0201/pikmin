/**
 * 皮克敏 Bloom 飾品探測器 - 主應用程式邏輯
 */

import { DECOR_RULES, DECOR_RULES_MAP, getAllDecorIds } from './decor-rules.js';
import { fetchDecorPOIs, calculateHaversineDistance } from './overpass.js';
import { RadarCanvas } from './radar-canvas.js';
import { loadUserSettings, saveUserSettings } from './cache.js';

// 預設熱門測試座標
export const PRESET_LOCATIONS = [
  { name: '台北車站', lat: 25.04778, lng: 121.51704 },
  { name: '高雄巨蛋', lat: 22.66986, lng: 120.30252 },
  { name: '台中歌劇院', lat: 24.16298, lng: 120.64058 },
  { name: '台南孔廟', lat: 22.99042, lng: 120.20436 },
  { name: '新竹巨城', lat: 24.80942, lng: 120.97545 },
  { name: '板橋車站', lat: 25.01391, lng: 121.46278 },
  { name: '東京車站 (海外)', lat: 35.68124, lng: 139.76712 },
];

export class PikminApp {
  constructor() {
    this.currentPosition = null; // { lat, lng, accuracy }
    this.selectedDecorIds = new Set(getAllDecorIds());
    this.displayLimit = 25; // 10, 25, 50, 100, 9999
    this.sortRule = 'pure'; // 'distance' | 'pure' | 'matches'
    this.radiusMeters = 1000; // 300, 500, 1000, 2000, 3000
    this.rawPois = [];
    this.rawCells = [];
    this.activeAbortController = null;
    this.isQuerying = false;

    this.initSettings();
    this.initDOM();
    this.initRadar();
    this.bindEvents();
    this.requestGPSLocation();
  }

  initSettings() {
    const saved = loadUserSettings({
      selectedDecorIds: getAllDecorIds(),
      displayLimit: 25,
      sortRule: 'pure',
      radiusMeters: 1000,
    });

    if (saved.selectedDecorIds && Array.isArray(saved.selectedDecorIds)) {
      this.selectedDecorIds = new Set(saved.selectedDecorIds);
    }
    this.displayLimit = Number(saved.displayLimit) || 25;
    this.sortRule = saved.sortRule || 'pure';
    this.radiusMeters = Number(saved.radiusMeters) || 1000;
  }

  saveCurrentSettings() {
    saveUserSettings({
      selectedDecorIds: Array.from(this.selectedDecorIds),
      displayLimit: this.displayLimit,
      sortRule: this.sortRule,
      radiusMeters: this.radiusMeters,
    });
  }

  initDOM() {
    // 取得主要 DOM 元素
    this.elements = {
      gpsStatusText: document.getElementById('gps-status-text'),
      gpsCoordText: document.getElementById('gps-coord-text'),
      btnRefreshGPS: document.getElementById('btn-refresh-gps'),
      btnManualGPS: document.getElementById('btn-manual-gps'),
      btnPresetLocations: document.getElementById('btn-presets'),
      presetModal: document.getElementById('preset-modal'),
      manualModal: document.getElementById('manual-modal'),
      decorFilterPanel: document.getElementById('decor-filter-panel'),
      decorGrid: document.getElementById('decor-grid'),
      decorSearchInput: document.getElementById('decor-search-input'),
      btnSelectAllDecors: document.getElementById('btn-select-all-decors'),
      btnClearAllDecors: document.getElementById('btn-clear-all-decors'),
      btnToggleFilterDrawer: document.getElementById('btn-toggle-filter'),
      selectedCountBadge: document.getElementById('selected-count-badge'),
      selectSortRule: document.getElementById('select-sort-rule'),
      selectDisplayLimit: document.getElementById('select-display-limit'),
      selectRadius: document.getElementById('select-radius'),
      btnExecuteSearch: document.getElementById('btn-execute-search'),
      resultStats: document.getElementById('result-stats'),
      resultList: document.getElementById('result-list'),
      emptyState: document.getElementById('empty-state'),
      toast: document.getElementById('toast'),
      radarCanvas: document.getElementById('radar-canvas'),
      btnResetView: document.getElementById('btn-reset-view'),
    };

    // 套用選單初始值
    this.elements.selectSortRule.value = this.sortRule;
    this.elements.selectDisplayLimit.value = String(this.displayLimit);
    this.elements.selectRadius.value = String(this.radiusMeters);

    this.renderDecorSwitches();
  }

  initRadar() {
    this.radar = new RadarCanvas(this.elements.radarCanvas, {
      radiusMeters: this.radiusMeters,
      onSelect: (poi) => {
        this.highlightCardInList(poi.id);
      },
    });

    window.addEventListener('resize', () => {
      this.radar.resize();
    });
  }

  renderDecorSwitches() {
    const grid = this.elements.decorGrid;
    grid.innerHTML = '';

    const filterKeyword = (this.elements.decorSearchInput.value || '').trim().toLowerCase();

    DECOR_RULES.forEach(rule => {
      if (filterKeyword) {
        const matchName = rule.name.toLowerCase().includes(filterKeyword);
        const matchEn = rule.nameEn.toLowerCase().includes(filterKeyword);
        const matchGroup = rule.group.toLowerCase().includes(filterKeyword);
        if (!matchName && !matchEn && !matchGroup) return;
      }

      const isChecked = this.selectedDecorIds.has(rule.id);

      const label = document.createElement('label');
      label.className = `decor-chip ${isChecked ? 'active' : ''}`;
      label.style.setProperty('--decor-color', rule.color);

      label.innerHTML = `
        <input type="checkbox" value="${rule.id}" ${isChecked ? 'checked' : ''} />
        <span class="decor-dot" style="background-color: ${rule.color}"></span>
        <span class="decor-symbol">${rule.symbol}</span>
        <span class="decor-name">${rule.name}</span>
      `;

      const checkbox = label.querySelector('input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.selectedDecorIds.add(rule.id);
          label.classList.add('active');
        } else {
          this.selectedDecorIds.delete(rule.id);
          label.classList.remove('active');
        }
        this.updateDecorCountBadge();
        this.saveCurrentSettings();
      });

      grid.appendChild(label);
    });

    this.updateDecorCountBadge();
  }

  updateDecorCountBadge() {
    const count = this.selectedDecorIds.size;
    const total = DECOR_RULES.length;
    this.elements.selectedCountBadge.textContent = `${count} / ${total}`;
  }

  bindEvents() {
    // 重新定位按鈕
    this.elements.btnRefreshGPS.addEventListener('click', () => {
      this.requestGPSLocation();
    });

    // 預設熱門地點對話框
    this.elements.btnPresetLocations.addEventListener('click', () => {
      this.openPresetModal();
    });

    // 手動輸入座標對話框
    this.elements.btnManualGPS.addEventListener('click', () => {
      this.openManualModal();
    });

    // 飾品搜尋篩選
    this.elements.decorSearchInput.addEventListener('input', () => {
      this.renderDecorSwitches();
    });

    // 全選飾品
    this.elements.btnSelectAllDecors.addEventListener('click', () => {
      getAllDecorIds().forEach(id => this.selectedDecorIds.add(id));
      this.renderDecorSwitches();
      this.saveCurrentSettings();
    });

    // 清除全選
    this.elements.btnClearAllDecors.addEventListener('click', () => {
      this.selectedDecorIds.clear();
      this.renderDecorSwitches();
      this.saveCurrentSettings();
    });

    // 開關飾品篩選面板抽屜
    this.elements.btnToggleFilterDrawer.addEventListener('click', () => {
      this.elements.decorFilterPanel.classList.toggle('expanded');
    });

    // 排序與數量選項改變
    this.elements.selectSortRule.addEventListener('change', (e) => {
      this.sortRule = e.target.value;
      this.saveCurrentSettings();
      this.applySortingAndRender();
    });

    this.elements.selectDisplayLimit.addEventListener('change', (e) => {
      this.displayLimit = Number(e.target.value);
      this.saveCurrentSettings();
      this.applySortingAndRender();
    });

    this.elements.selectRadius.addEventListener('change', (e) => {
      this.radiusMeters = Number(e.target.value);
      this.saveCurrentSettings();
      this.radar.maxDistance = this.radiusMeters;
      this.radar.render();
      this.executeQuery();
    });

    // 立即重新查詢按鈕
    this.elements.btnExecuteSearch.addEventListener('click', () => {
      this.executeQuery();
    });

    // 雷達重設視圖
    this.elements.btnResetView.addEventListener('click', () => {
      this.radar.resetView();
    });
  }

  /**
   * 呼叫 Web Geolocation API 獲取使用者 GPS
   */
  requestGPSLocation() {
    this.elements.gpsStatusText.textContent = '🛰️ 正在讀取 GPS 座標...';
    this.elements.gpsCoordText.textContent = '--';

    if (!navigator.geolocation) {
      this.showToast('⚠️ 您的瀏覽器不支援定位功能，已切換至預設地點');
      this.setFallbackLocation();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy = Math.round(pos.coords.accuracy || 0);

        this.currentPosition = { lat, lng, accuracy };
        this.elements.gpsStatusText.textContent = `📍 目前定位 (精確度 ±${accuracy}m)`;
        this.elements.gpsCoordText.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        this.radar.setUserLocation(lat, lng);
        this.showToast('✅ 定位成功！開始掃描附近飾品...');
        this.executeQuery();
      },
      (err) => {
        console.warn('[GPS] Error:', err);
        let msg = '定位失敗，已切換為台北車站';
        if (err.code === 1) msg = '定位權限被拒絕，已切換為台北車站';
        else if (err.code === 2) msg = '無法取得位置，已切換為台北車站';
        else if (err.code === 3) msg = '定位超時，已切換為台北車站';

        this.showToast(`⚠️ ${msg}`);
        this.setFallbackLocation();
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  }

  setFallbackLocation() {
    const fallback = PRESET_LOCATIONS[0]; // 台北車站
    this.currentPosition = { lat: fallback.lat, lng: fallback.lng, accuracy: 50 };
    this.elements.gpsStatusText.textContent = `📍 預設位置 (${fallback.name})`;
    this.elements.gpsCoordText.textContent = `${fallback.lat.toFixed(5)}, ${fallback.lng.toFixed(5)}`;
    this.radar.setUserLocation(fallback.lat, fallback.lng);
    this.executeQuery();
  }

  /**
   * 執行查詢
   */
  async executeQuery() {
    if (!this.currentPosition) return;
    if (this.selectedDecorIds.size === 0) {
      this.showToast('⚠️ 請至少勾選一種想搜尋的飾品');
      this.renderEmptyState('請在上方篩選面板勾選想找的飾品');
      return;
    }

    // 中斷進行中的查詢
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
    this.activeAbortController = new AbortController();

    this.isQuerying = true;
    this.elements.btnExecuteSearch.classList.add('loading');
    this.elements.btnExecuteSearch.textContent = '⏳ 查詢中...';

    const selectedRules = Array.from(this.selectedDecorIds)
      .map(id => DECOR_RULES_MAP.get(id))
      .filter(Boolean);

    const startTime = performance.now();

    try {
      const result = await fetchDecorPOIs({
        lat: this.currentPosition.lat,
        lng: this.currentPosition.lng,
        radiusMeters: this.radiusMeters,
        selectedRules,
        abortSignal: this.activeAbortController.signal,
        onProgress: (info) => {
          if (info.message) {
            this.elements.resultStats.textContent = info.message;
          }
        },
      });

      const elapsed = Math.round(performance.now() - startTime);

      this.rawPois = result.pois;
      this.rawCells = result.cells;

      // 更新畫布數據
      this.radar.setData(this.rawPois, this.rawCells, this.radiusMeters);

      // 套用排序並呈現結果列表
      this.applySortingAndRender(elapsed);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[Query] Error:', err);
      this.showToast(`❌ 查詢失敗: ${err.message}`);
      this.renderEmptyState('查詢失敗，請檢查網路連線或更換伺服器');
    } finally {
      this.isQuerying = false;
      this.elements.btnExecuteSearch.classList.remove('loading');
      this.elements.btnExecuteSearch.textContent = '⚡ 立即搜尋';
    }
  }

  /**
   * 排序與過濾呈現核心演算法
   */
  applySortingAndRender(elapsedMs = null) {
    if (!this.rawCells || this.rawCells.length === 0) {
      this.renderEmptyState('此範圍內未偵測到相符的飾品地標，可嘗試加大半徑或勾選更多類別');
      this.elements.resultStats.innerHTML = `掃描半徑 ${this.radiusMeters}m ｜ 找到 0 處飾品點位`;
      return;
    }

    // 建立 Cell 與其內部的 POI 清單
    let displayList = [...this.rawCells];

    // 依照使用者選擇的規則排序
    if (this.sortRule === 'pure') {
      // 1. 純種區優先 (只有 1 種飾品且為使用者所選) > 混雜區；同等級按距離
      displayList.sort((a, b) => {
        if (a.isPure && !b.isPure) return -1;
        if (!a.isPure && b.isPure) return 1;
        // 若同為混雜區，飾品種數愈少優先
        if (a.typeCount !== b.typeCount) return a.typeCount - b.typeCount;
        return a.distance - b.distance;
      });
    } else if (this.sortRule === 'matches') {
      // 2. 最多符合優先 (涵蓋使用者勾選的目標飾品數量愈多愈好)
      displayList.sort((a, b) => {
        const matchesA = Array.from(a.decorTypes).filter(id => this.selectedDecorIds.has(id)).length;
        const matchesB = Array.from(b.decorTypes).filter(id => this.selectedDecorIds.has(id)).length;
        if (matchesB !== matchesA) return matchesB - matchesA;
        return a.distance - b.distance;
      });
    } else {
      // 3. 距離優先 (由近到遠)
      displayList.sort((a, b) => a.distance - b.distance);
    }

    // 限制呈現筆數
    const totalFound = displayList.length;
    const pureCount = displayList.filter(c => c.isPure).length;
    const finalItems = displayList.slice(0, this.displayLimit);

    // 更新統計列
    const timeInfo = elapsedMs !== null ? ` (耗時 ${elapsedMs}ms)` : '';
    this.elements.resultStats.innerHTML = `
      <span>共找到 <strong>${totalFound}</strong> 個 S2 網格點位</span>
      <span class="badge-pure-count">🟢 純種區: <strong>${pureCount}</strong> 處</span>
      <span class="text-muted">${timeInfo}</span>
    `;

    this.renderResultCards(finalItems);
  }

  renderResultCards(cellItems) {
    const list = this.elements.resultList;
    list.innerHTML = '';

    cellItems.forEach((cell, index) => {
      const card = document.createElement('div');
      card.className = `result-card ${cell.isPure ? 'pure-cell-card' : ''}`;
      card.id = `cell-card-${cell.cellKey.replace(/[^a-zA-Z0-9]/g, '_')}`;

      // 主要代表 POI
      const mainPoi = cell.pois[0] || { name: 'S2 網格區域', lat: cell.center.lat, lng: cell.center.lng };
      const pureBadge = cell.isPure
        ? `<span class="tag-badge tag-pure">🟢 純種區 100% 命中</span>`
        : `<span class="tag-badge tag-mixed">🟡 ${cell.typeCount} 種飾品混雜</span>`;

      // 飾品晶片列表
      const decorBadges = cell.decorList.map(d => `
        <span class="decor-mini-chip" style="--chip-color: ${d.color}">
          <span>${d.symbol}</span>
          <span>${d.name}</span>
        </span>
      `).join('');

      // 其他包含的地點名稱
      const poiNames = cell.pois.slice(0, 3).map(p => p.name).join('、');
      const moreText = cell.pois.length > 3 ? ` 等 ${cell.pois.length} 個地標` : '';

      const lat = cell.center.lat.toFixed(5);
      const lng = cell.center.lng.toFixed(5);

      card.innerHTML = `
        <div class="card-header">
          <div class="card-rank">#${index + 1}</div>
          <div class="card-title-group">
            <h4 class="card-title">${mainPoi.name}</h4>
            <div class="card-subnames">${poiNames}${moreText}</div>
          </div>
          ${pureBadge}
        </div>

        <div class="card-decors-row">
          ${decorBadges}
        </div>

        <div class="card-footer">
          <div class="card-meta">
            <span class="meta-item">📏 距離 <strong>${cell.distance}m</strong></span>
            <span class="meta-item coord-clickable" title="點擊跳轉 Map App" data-lat="${lat}" data-lng="${lng}">
              📍 <span class="coord-text">${lat}, ${lng}</span>
            </span>
          </div>

          <div class="card-actions">
            <button class="btn-action btn-map-open" data-lat="${lat}" data-lng="${lng}" title="開啟外部地圖 App 導航">
              🗺️ 導航
            </button>
            <button class="btn-action btn-copy-coord" data-lat="${lat}" data-lng="${lng}" title="複製經緯度座標">
              📋 複製
            </button>
          </div>
        </div>
      `;

      // 點擊卡片與雷達聯動
      card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('.coord-clickable')) return;
        this.radar.selectedItem = mainPoi;
        this.radar.render();
      });

      // 點擊座標或導航按鈕跳轉 Map App
      const openMapButtons = card.querySelectorAll('.btn-map-open, .coord-clickable');
      openMapButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetLat = btn.dataset.lat;
          const targetLng = btn.dataset.lng;
          this.openInMapApp(targetLat, targetLng);
        });
      });

      // 複製座標按鈕
      const copyBtn = card.querySelector('.btn-copy-coord');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetLat = copyBtn.dataset.lat;
        const targetLng = copyBtn.dataset.lng;
        this.copyCoordinatesToClipboard(targetLat, targetLng);
      });

      list.appendChild(card);
    });
  }

  highlightCardInList(poiId) {
    // 依據 POI 尋找所屬網格卡片並平滑滾動
    const foundPoi = this.rawPois.find(p => p.id === poiId);
    if (!foundPoi) return;

    const cardId = `cell-card-${foundPoi.cellKey.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const cardEl = document.getElementById(cardId);
    if (cardEl) {
      document.querySelectorAll('.result-card.highlighted').forEach(c => c.classList.remove('highlighted'));
      cardEl.classList.add('highlighted');
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /**
   * 點擊跳轉到原生 Map App (Google Maps / Apple Maps / Geo URI)
   */
  openInMapApp(lat, lng) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    let url = '';

    if (isIOS) {
      // iOS Apple Maps 深度連結
      url = `https://maps.apple.com/?q=${lat},${lng}&ll=${lat},${lng}`;
    } else {
      // Android / 通用 Google Maps 深度連結
      url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }

    this.showToast(`🚀 正在為您開啟地圖 App (${lat}, ${lng})...`);
    window.open(url, '_blank');
  }

  /**
   * 一鍵複製經緯度至剪貼簿
   */
  async copyCoordinatesToClipboard(lat, lng) {
    const text = `${lat}, ${lng}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      this.showToast(`📋 已複製座標: ${text}`);
    } catch (err) {
      this.showToast(`座標: ${text}`);
    }
  }

  renderEmptyState(message) {
    this.elements.resultList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌱</div>
        <p>${message}</p>
      </div>
    `;
  }

  showToast(message) {
    const toast = this.elements.toast;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2800);
  }

  openPresetModal() {
    const modal = this.elements.presetModal;
    const list = modal.querySelector('.preset-list');
    list.innerHTML = '';

    PRESET_LOCATIONS.forEach(loc => {
      const item = document.createElement('button');
      item.className = 'preset-item-btn';
      item.innerHTML = `
        <strong>${loc.name}</strong>
        <span class="text-muted">${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}</span>
      `;
      item.addEventListener('click', () => {
        this.currentPosition = { lat: loc.lat, lng: loc.lng, accuracy: 20 };
        this.elements.gpsStatusText.textContent = `📍 目前位置 (${loc.name})`;
        this.elements.gpsCoordText.textContent = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
        this.radar.setUserLocation(loc.lat, loc.lng);
        modal.classList.remove('visible');
        this.showToast(`已切換至 ${loc.name}`);
        this.executeQuery();
      });
      list.appendChild(item);
    });

    modal.classList.add('visible');
    modal.querySelector('.btn-close-modal').onclick = () => modal.classList.remove('visible');
  }

  openManualModal() {
    const modal = this.elements.manualModal;
    const inputLat = modal.querySelector('#manual-lat');
    const inputLng = modal.querySelector('#manual-lng');

    if (this.currentPosition) {
      inputLat.value = this.currentPosition.lat.toFixed(5);
      inputLng.value = this.currentPosition.lng.toFixed(5);
    }

    modal.classList.add('visible');

    modal.querySelector('.btn-close-modal').onclick = () => modal.classList.remove('visible');
    modal.querySelector('.btn-confirm-manual').onclick = () => {
      const lat = parseFloat(inputLat.value);
      const lng = parseFloat(inputLng.value);

      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        alert('請輸入合法的經緯度數值！');
        return;
      }

      this.currentPosition = { lat, lng, accuracy: 10 };
      this.elements.gpsStatusText.textContent = '📍 手動指定坐標';
      this.elements.gpsCoordText.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      this.radar.setUserLocation(lat, lng);
      modal.classList.remove('visible');
      this.showToast(`已套用座標: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      this.executeQuery();
    };
  }
}

// 啟動應用
window.addEventListener('DOMContentLoaded', () => {
  window.pikminApp = new PikminApp();
});
