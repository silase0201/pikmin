/**
 * 高效能空白座標雷達畫布 (HTML5 Canvas Radar & Coordinate Grid)
 * 
 * 核心特色：
 * 1. 預設顯示空白 + 座標與極坐標雷達網格，0 張底圖瓦片請求，毫秒級啟動
 * 2. 繪製 S2 Level 17 網格多邊形（綠色純種區、黃色混雜區）
 * 3. 支援觸控與滑鼠平移 (Pan)、縮放 (Zoom)、點擊選取座標
 * 4. 點選後直接提供座標與跳轉 Map App 觸發
 */

export class RadarCanvas {
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.userLocation = null; // { lat, lng }
    this.pois = [];
    this.cells = [];
    this.selectedItem = null;
    this.onSelectCallback = options.onSelect || null;

    // 視圖狀態
    this.zoom = 1.0; // 縮放係數
    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.maxDistance = options.radiusMeters || 1000;

    // 底圖狀態 (預設關閉：空白+坐標)
    this.showTileMap = false;
    this.tileCache = new Map();

    this.initCanvasSize();
    this.bindEvents();
    this.startAnimation();
  }

  initCanvasSize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height || 500;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(dpr, dpr);
  }

  resize() {
    this.initCanvasSize();
    this.render();
  }

  setUserLocation(lat, lng) {
    this.userLocation = { lat, lng };
    this.resetView();
  }

  setData(pois, cells, radiusMeters) {
    this.pois = pois || [];
    this.cells = cells || [];
    if (radiusMeters) this.maxDistance = radiusMeters;
    this.render();
  }

  resetView() {
    this.offsetX = 0;
    this.offsetY = 0;
    this.zoom = 1.0;
    this.render();
  }

  /**
   * 將經緯度轉為以使用者為中心 (0,0) 的畫布相對像素坐標
   */
  latLngToCanvasXY(lat, lng) {
    if (!this.userLocation) return { x: 0, y: 0 };

    const earthRadius = 6378137;
    const centerLatRad = (this.userLocation.lat * Math.PI) / 180;
    
    // 平面近程投影 (Equirectangular approximation, 適用於 5km 內的高精度投影)
    const dx = ((lng - this.userLocation.lng) * Math.PI / 180) * earthRadius * Math.cos(centerLatRad);
    const dy = -((lat - this.userLocation.lat) * Math.PI / 180) * earthRadius; // 緯度北為負Y

    // 縮放比例：將 maxDistance 對應到畫布半徑的 80%
    const baseRadiusPx = Math.min(this.width, this.height) * 0.42;
    const pixelsPerMeter = (baseRadiusPx / this.maxDistance) * this.zoom;

    const centerX = this.width / 2 + this.offsetX;
    const centerY = this.height / 2 + this.offsetY;

    return {
      x: centerX + dx * pixelsPerMeter,
      y: centerY + dy * pixelsPerMeter,
    };
  }

  /**
   * 畫布像素反算回經緯度
   */
  canvasXYToLatLng(x, y) {
    if (!this.userLocation) return { lat: 0, lng: 0 };

    const centerX = this.width / 2 + this.offsetX;
    const centerY = this.height / 2 + this.offsetY;

    const baseRadiusPx = Math.min(this.width, this.height) * 0.42;
    const pixelsPerMeter = (baseRadiusPx / this.maxDistance) * this.zoom;

    const dx = (x - centerX) / pixelsPerMeter;
    const dy = (y - centerY) / pixelsPerMeter;

    const earthRadius = 6378137;
    const centerLatRad = (this.userLocation.lat * Math.PI) / 180;

    const lat = this.userLocation.lat - (dy / earthRadius) * (180 / Math.PI);
    const lng = this.userLocation.lng + (dx / (earthRadius * Math.cos(centerLatRad))) * (180 / Math.PI);

    return { lat, lng };
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. 繪製深色科技背景 (空白坐標圖)
    this.drawBackground(ctx);

    if (!this.userLocation) {
      this.drawWaitingGPS(ctx);
      return;
    }

    // 2. 繪製極坐標距離環與方位標記
    this.drawRadarGrid(ctx);

    // 3. 繪製 S2 Level 17 網格多邊形 (標記純種區與混雜區)
    this.drawS2Cells(ctx);

    // 4. 繪製 POI 點位 (向量點與符號)
    this.drawPOIs(ctx);

    // 5. 繪製使用者中心光圈
    this.drawUserPulse(ctx);

    // 6. 繪製比例尺與座標資訊列
    this.drawOverlayHUD(ctx);
  }

  drawBackground(ctx) {
    // 漸層暗色系背景 (深黑藍色，凸顯雷達綠色純種區)
    const gradient = ctx.createRadialGradient(
      this.width / 2, this.height / 2, 50,
      this.width / 2, this.height / 2, Math.max(this.width, this.height)
    );
    gradient.addColorStop(0, '#0f172a');
    gradient.addColorStop(1, '#020617');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    // 輕量背景細網格 (每 50px 虛線)
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = (this.offsetX % step); x < this.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (let y = (this.offsetY % step); y < this.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWaitingGPS(ctx) {
    ctx.save();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('正在獲取目前 GPS 定位坐標...', this.width / 2, this.height / 2);
    ctx.restore();
  }

  drawRadarGrid(ctx) {
    const center = this.latLngToCanvasXY(this.userLocation.lat, this.userLocation.lng);
    const baseRadiusPx = Math.min(this.width, this.height) * 0.42;
    const pixelsPerMeter = (baseRadiusPx / this.maxDistance) * this.zoom;

    // 依據搜尋半徑決定距離環階層 (100m, 250m, 500m, 1000m, 2000m)
    let ringDistances = [100, 250, 500, 1000];
    if (this.maxDistance <= 500) ringDistances = [50, 100, 250, 500];
    else if (this.maxDistance > 2000) ringDistances = [500, 1000, 2000, 3000];

    ctx.save();
    ctx.lineWidth = 1;

    // 距離同心圓
    ringDistances.forEach((dist) => {
      const radiusPx = dist * pixelsPerMeter;
      if (radiusPx < 10) return;

      const isMax = (dist === this.maxDistance);
      ctx.strokeStyle = isMax ? 'rgba(56, 189, 248, 0.4)' : 'rgba(148, 163, 184, 0.15)';
      ctx.setLineDash(isMax ? [] : [4, 4]);

      ctx.beginPath();
      ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();

      // 距離文字標籤
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${dist}m`, center.x + 6, center.y - radiusPx - 2);
    });

    // 正北/正東/正南/正西 十字軸
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.beginPath();
    ctx.moveTo(center.x, 0);
    ctx.lineTo(center.x, this.height);
    ctx.moveTo(0, center.y);
    ctx.lineTo(this.width, center.y);
    ctx.stroke();

    // 方位文字
    ctx.setLineDash([]);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('N (北)', center.x, 24);
    ctx.fillStyle = '#64748b';
    ctx.fillText('S (南)', center.x, this.height - 12);
    ctx.fillText('E (東)', this.width - 24, center.y + 4);
    ctx.fillText('W (西)', 24, center.y + 4);

    ctx.restore();
  }

  drawS2Cells(ctx) {
    if (!this.cells || this.cells.length === 0) return;

    ctx.save();
    this.cells.forEach(cell => {
      if (!cell.corners || cell.corners.length < 4) return;

      const pts = cell.corners.map(c => this.latLngToCanvasXY(c.lat, c.lng));

      // 畫多邊形
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();

      // 純種區 (isPure) 使用鮮明綠色翡翠光，混雜區使用淡灰橘色
      if (cell.isPure) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 1.8;
      } else if (cell.typeCount <= 3) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
        ctx.lineWidth = 1;
      } else {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.lineWidth = 0.8;
      }

      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  drawPOIs(ctx) {
    if (!this.pois || this.pois.length === 0) return;

    ctx.save();
    this.pois.forEach(poi => {
      const pos = this.latLngToCanvasXY(poi.lat, poi.lng);

      // 若在視窗外則略過
      if (pos.x < -30 || pos.x > this.width + 30 || pos.y < -30 || pos.y > this.height + 30) {
        return;
      }

      const isSelected = this.selectedItem && this.selectedItem.id === poi.id;
      const radius = isSelected ? 12 : 8;

      // 點位外圈陰影與色彩
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = poi.decorColor || '#38bdf8';
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#ffffff' : '#0f172a';
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      // 如果有被選取，畫強調光環
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = poi.decorColor || '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 符號簡寫 (Symbol)
      ctx.font = isSelected ? '12px sans-serif' : '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(poi.decorSymbol || '•', pos.x, pos.y);
    });
    ctx.restore();
  }

  drawUserPulse(ctx) {
    const center = this.latLngToCanvasXY(this.userLocation.lat, this.userLocation.lng);

    ctx.save();
    // 脈衝波 (由時間驅動)
    const time = Date.now() / 1000;
    const pulseSize = 10 + (time % 2) * 14;
    const pulseAlpha = Math.max(0, 1 - (time % 2) / 2);

    ctx.beginPath();
    ctx.arc(center.x, center.y, pulseSize, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${pulseAlpha * 0.7})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 中心定位實心點
    ctx.beginPath();
    ctx.arc(center.x, center.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 標籤
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('目前位置 (YOU)', center.x, center.y + 16);

    ctx.restore();
  }

  drawOverlayHUD(ctx) {
    ctx.save();
    // 左下角：目前中心經緯度與比例尺
    if (this.userLocation) {
      const text = `中心座標: ${this.userLocation.lat.toFixed(5)}, ${this.userLocation.lng.toFixed(5)}`;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.roundRect ? ctx.roundRect(12, this.height - 36, 260, 26, 6) : ctx.rect(12, this.height - 36, 260, 26);
      ctx.fill();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(text, 20, this.height - 19);
    }
    ctx.restore();
  }

  startAnimation() {
    let lastRender = 0;
    const loop = (timestamp) => {
      // 每 150ms 重新渲染一次脈衝微動畫（節省電量與 CPU）
      if (timestamp - lastRender > 150) {
        this.render();
        lastRender = timestamp;
      }
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  bindEvents() {
    // 拖曳 (Pan)
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX - this.offsetX;
      this.dragStartY = e.clientY - this.offsetY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.offsetX = e.clientX - this.dragStartX;
      this.offsetY = e.clientY - this.dragStartY;
      this.render();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // 滾輪縮放 (Zoom)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const newZoom = Math.min(Math.max(this.zoom * zoomFactor, 0.4), 4.0);
      this.zoom = newZoom;
      this.render();
    }, { passive: false });

    // 點擊事件：選取 POI
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      let found = null;
      let minDis = 18; // 點擊感應半徑 (px)

      for (const poi of this.pois) {
        const p = this.latLngToCanvasXY(poi.lat, poi.lng);
        const dis = Math.hypot(p.x - clickX, p.y - clickY);
        if (dis < minDis) {
          minDis = dis;
          found = poi;
        }
      }

      this.selectedItem = found;
      this.render();

      if (this.onSelectCallback && found) {
        this.onSelectCallback(found);
      }
    });

    // 觸控支援 (Touch Pan & Tap)
    let touchStartX = 0;
    let touchStartY = 0;

    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX - this.offsetX;
        touchStartY = e.touches[0].clientY - this.offsetY;
      }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        this.offsetX = e.touches[0].clientX - touchStartX;
        this.offsetY = e.touches[0].clientY - touchStartY;
        this.render();
      }
    }, { passive: true });
  }

  destroy() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
  }
}
