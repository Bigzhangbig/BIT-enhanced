// ==UserScript==
// @name         中国大学MOOC-自动学习课件
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  自动点击未学习的视频和文档，每个停留5秒后切换
// @license      GPL-3.0-or-later
// @supportURL   https://github.com/YDX-2147483647/BIT-enhanced/issues
// @author       Harvey
// @match        *://www.icourse163.org/spoc/learn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============ 配置 ============
  const CONFIG = {
    stayDuration: 5000,
    checkInterval: 1500,
  };

  // ============ 状态 ============
  let isRunning = false;
  let totalProcessed = 0;
  let totalTarget = 0;
  let countdownTimer = null;
  let remainingMs = 0;
  let panel = null;

  // ============ 工具函数 ============

  // 展开所有折叠的章节（排除考试章节）
  function expandAllSections() {
    let expanded = 0;

    // 只选择非考试章节的标题框
    const titleBoxes = document.querySelectorAll('.m-learnChapterNormal:not(.exam) .titleBox.j-titleBox');
    titleBoxes.forEach(box => {
      const parent = box.closest('.m-learnChapterNormal');
      if (!parent || parent.classList.contains('exam')) return;

      // 检查 lessonBox 是否有内容
      const lessonBox = parent.querySelector('.lessonBox.j-lessoBox');
      const hasContent = lessonBox && lessonBox.querySelectorAll('.f-icon.lsicon').length > 0;

      if (!hasContent) {
        box.click();
        expanded++;
      }
    });

    return expanded;
  }

  // 等待所有章节展开
  function expandAndWait(callback) {
    const expanded = expandAllSections();
    if (expanded > 0) {
      // 等待展开动画和内容加载
      setTimeout(() => {
        // 再次检查是否有新内容加载
        const totalItems = document.querySelectorAll('.f-icon.lsicon').length;
        if (totalItems === 0) {
          // 可能还需要更多时间加载
          setTimeout(callback, 1000);
        } else {
          callback();
        }
      }, 800);
    } else {
      callback();
    }
  }

  function isDetailView() {
    return window.location.hash.includes('type=detail');
  }

  function goToListView() {
    window.location.hash = '#/learn/content';
  }

  function getUnlearnedItems() {
    const items = document.querySelectorAll('.f-icon.lsicon:not(.learned)');
    return Array.from(items)
      .map(el => ({
        element: el,
        title: el.getAttribute('title') || el.textContent.trim(),
        cid: el.getAttribute('data-cid'),
        type: el.querySelector('.tag')?.textContent.trim() || '未知',
      }))
      .filter(item => item.type !== '讨论'); // 跳过讨论
  }

  function getStats() {
    const total = document.querySelectorAll('.f-icon.lsicon').length;
    const learned = document.querySelectorAll('.f-icon.lsicon.learned').length;
    return { total, learned, unlearned: total - learned };
  }

  // 等待列表加载
  function waitForList(callback, maxWait = 5000) {
    const start = Date.now();
    const check = setInterval(() => {
      const items = document.querySelectorAll('.f-icon.lsicon');
      if (items.length > 0 || Date.now() - start > maxWait) {
        clearInterval(check);
        setTimeout(callback, 300);
      }
    }, 200);
  }

  // ============ 核心逻辑 ============
  function startAutoLearn() {
    if (isRunning) return;

    // 如果在详情页，先回列表
    if (isDetailView()) {
      goToListView();
      waitForList(() => startAutoLearn());
      return;
    }

    // 先展开所有折叠的章节
    expandAndWait(() => {
      const items = getUnlearnedItems();
      if (items.length === 0) {
        updateStatus('ALL CLEAR', '全部内容已学习完成');
        return;
      }

      isRunning = true;
      totalProcessed = 0;
      totalTarget = items.length;
      updateBtnState();
      processNextItem();
    });
    return; // expandAndWait 是异步的，这里直接 return
  }

  function processNextItem() {
    if (!isRunning) return;

    // 确保在列表页
    if (isDetailView()) {
      goToListView();
      waitForList(() => processNextItem());
      return;
    }

    // 每次处理前都展开章节（防止折叠）
    expandAndWait(() => {

    const items = getUnlearnedItems();
    if (items.length === 0 || totalProcessed >= totalTarget) {
      stopAutoLearn();
      updateStatus('COMPLETE', '本轮学习已完成');
      pulsePanel('success');
      return;
    }

    const item = items[0];
    const pct = Math.round((totalProcessed / totalTarget) * 100);

    updateStatus(item.title, `${item.type} · ${totalProcessed + 1}/${totalTarget}`, pct);

    // 滚动并高亮
    item.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightElement(item.element);

    // 点击
    item.element.click();
    totalProcessed++;

    // 倒计时后处理下一个
    startCountdown(CONFIG.stayDuration, () => {
      // 回到列表页
      if (isDetailView()) {
        goToListView();
        waitForList(() => processNextItem());
      } else {
        processNextItem();
      }
    });

    }); // end expandAndWait
  }

  function highlightElement(el) {
    el.style.outline = '3px solid #c0392b';
    el.style.outlineOffset = '2px';
    el.style.borderRadius = '4px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.borderRadius = '';
    }, CONFIG.stayDuration - 200);
  }

  function startCountdown(duration, callback) {
    clearCountdown();
    remainingMs = duration;
    updateCountdownDisplay();
    showCountdown(true);

    countdownTimer = setInterval(() => {
      remainingMs -= 100;
      if (remainingMs <= 0) {
        clearCountdown();
        callback();
      } else {
        updateCountdownDisplay();
      }
    }, 100);
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    remainingMs = 0;
    showCountdown(false);
  }

  function updateCountdownDisplay() {
    const el = panel?.querySelector('.countdown-value');
    if (el) el.textContent = (remainingMs / 1000).toFixed(1) + 's';
  }

  function showCountdown(show) {
    const el = panel?.querySelector('.countdown');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function stopAutoLearn() {
    isRunning = false;
    clearCountdown();
    updateBtnState();
  }

  function toggleAutoLearn() {
    if (isRunning) {
      stopAutoLearn();
      updateStatus('PAUSED', '已暂停');
    } else {
      startAutoLearn();
    }
  }

  function updateBtnState() {
    const btn = panel?.querySelector('.btn-main');
    if (btn) {
      btn.textContent = isRunning ? 'PAUSE' : 'START';
      btn.classList.toggle('active', isRunning);
    }
  }

  // ============ UI 更新 ============
  function updateStatus(title, subtitle, pct) {
    if (!panel) return;

    const titleEl = panel.querySelector('.status-title');
    const subEl = panel.querySelector('.status-subtitle');
    const pctEl = panel.querySelector('.ring-pct');
    const ringCircle = panel.querySelector('.ring-progress');

    if (titleEl && title !== undefined) titleEl.textContent = title;
    if (subEl && subtitle !== undefined) subEl.textContent = subtitle;

    const stats = getStats();
    const percent = pct ?? (stats.total > 0 ? Math.round((stats.learned / stats.total) * 100) : 0);

    if (pctEl) pctEl.textContent = percent;
    if (ringCircle) {
      const circumference = 2 * Math.PI * 42;
      ringCircle.style.strokeDashoffset = circumference * (1 - percent / 100);
    }

    const totalEl = panel.querySelector('.stat-total .stat-num');
    const doneEl = panel.querySelector('.stat-done .stat-num');
    const leftEl = panel.querySelector('.stat-left .stat-num');
    if (totalEl) totalEl.textContent = stats.total;
    if (doneEl) doneEl.textContent = stats.learned;
    if (leftEl) leftEl.textContent = stats.unlearned;
  }

  function pulsePanel(type) {
    if (!panel) return;
    panel.classList.add(`pulse-${type}`);
    setTimeout(() => panel.classList.remove(`pulse-${type}`), 1200);
  }

  // ============ 面板创建 ============
  function createPanel() {
    const el = document.createElement('div');
    el.className = 'al-panel';
    el.innerHTML = `
      <style>
        .al-panel {
          --bg: #1a1a1a;
          --card: #232323;
          --accent: #c0392b;
          --accent2: #e74c3c;
          --cream: #f5f0e8;
          --gold: #d4a853;
          --green: #27ae60;
          --text: #e8e4dc;
          --muted: #888;
          --border: #333;

          position: fixed;
          bottom: 24px;
          right: 24px;
          width: 340px;
          background: var(--bg);
          border: 3px solid var(--border);
          border-radius: 2px;
          font-family: 'Space Mono', 'Courier New', monospace;
          color: var(--text);
          z-index: 999999;
          box-shadow:
            8px 8px 0 rgba(192, 57, 43, 0.3),
            0 20px 60px rgba(0,0,0,0.5);
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
                      box-shadow 0.3s ease;
          overflow: hidden;
        }

        .al-panel::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 4px;
          background: repeating-linear-gradient(
            90deg,
            var(--accent) 0, var(--accent) 8px,
            transparent 8px, transparent 16px
          );
        }

        .al-panel:hover {
          transform: translateY(-2px);
          box-shadow:
            10px 10px 0 rgba(192, 57, 43, 0.4),
            0 25px 70px rgba(0,0,0,0.6);
        }

        .al-panel.minimized {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          cursor: grab;
          overflow: hidden;
        }

        .al-panel.minimized .panel-body { display: none; }
        .al-panel.minimized .minimize-icon { display: flex; }

        .al-panel.pulse-success { animation: pulseGreen 1.2s ease; }

        @keyframes pulseGreen {
          0%, 100% { border-color: var(--border); }
          30% { border-color: var(--green); box-shadow: 0 0 30px rgba(39,174,96,0.4), 8px 8px 0 rgba(39,174,96,0.3); }
        }

        .minimize-icon {
          display: none;
          width: 100%;
          height: 100%;
          align-items: center;
          justify-content: center;
          font-size: 24px;
          background: var(--accent);
          cursor: grab;
        }

        .panel-body { position: relative; }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 10px;
          border-bottom: 1px solid var(--border);
        }

        .panel-title {
          font-size: 18px;
          font-weight: 400;
          letter-spacing: 0.5px;
          color: var(--cream);
        }

        .panel-title span { color: var(--accent); }

        .btn-min {
          width: 28px;
          height: 28px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 2px;
          color: var(--muted);
          cursor: pointer;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
          position: relative;
          z-index: 2;
        }

        .btn-min:hover { background: var(--accent); color: white; border-color: var(--accent); }

        .progress-section {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          border-bottom: 1px solid var(--border);
        }

        .ring-container {
          position: relative;
          width: 100px;
          height: 100px;
          flex-shrink: 0;
        }

        .ring-svg {
          transform: rotate(-90deg);
          width: 100px;
          height: 100px;
        }

        .ring-bg { fill: none; stroke: var(--border); stroke-width: 6; }

        .ring-progress {
          fill: none;
          stroke: var(--accent);
          stroke-width: 6;
          stroke-linecap: butt;
          stroke-dasharray: 263.89;
          stroke-dashoffset: 263.89;
          transition: stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ring-center {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          text-align: center;
        }

        .ring-pct {
          font-size: 28px;
          font-weight: 400;
          color: var(--cream);
          line-height: 1;
        }

        .ring-pct::after { content: '%'; font-size: 14px; color: var(--muted); }

        .status-info { flex: 1; min-width: 0; }

        .status-title {
          font-size: 15px;
          color: var(--cream);
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .status-subtitle {
          font-size: 11px;
          color: var(--muted);
          letter-spacing: 1px;
          text-transform: uppercase;
        }

        .countdown {
          margin-top: 8px;
          display: none;
          align-items: center;
          gap: 6px;
        }

        .countdown-label { font-size: 10px; color: var(--muted); letter-spacing: 1px; }
        .countdown-value { font-size: 14px; color: var(--gold); font-weight: 700; }

        .stats-row { display: flex; border-bottom: 1px solid var(--border); }

        .stat-item {
          flex: 1;
          padding: 12px 8px;
          text-align: center;
          border-right: 1px solid var(--border);
          transition: background 0.2s;
        }

        .stat-item:last-child { border-right: none; }
        .stat-item:hover { background: var(--card); }

        .stat-num { font-size: 24px; color: var(--cream); line-height: 1.2; }
        .stat-left .stat-num { color: var(--accent2); }

        .stat-label {
          font-size: 9px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: var(--muted);
          margin-top: 2px;
        }

        .btn-row {
          display: flex;
          padding: 12px 16px;
          gap: 8px;
          background: var(--card);
        }

        .btn-main {
          flex: 1;
          padding: 12px;
          background: var(--accent);
          border: 2px solid var(--accent);
          border-radius: 2px;
          color: white;
          font-family: 'Space Mono', 'Courier New', monospace;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 3px;
          cursor: pointer;
          transition: all 0.2s;
          text-transform: uppercase;
        }

        .btn-main:hover { background: var(--accent2); border-color: var(--accent2); transform: translateY(-1px); }
        .btn-main:active { transform: translateY(1px); }

        .btn-main.active {
          background: transparent;
          color: var(--accent);
          animation: blinkBorder 1.5s infinite;
        }

        @keyframes blinkBorder {
          0%, 100% { border-color: var(--accent); }
          50% { border-color: var(--gold); }
        }

        .btn-secondary {
          width: 44px;
          padding: 12px;
          background: transparent;
          border: 2px solid var(--border);
          border-radius: 2px;
          color: var(--muted);
          font-size: 16px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-secondary:hover { border-color: var(--cream); color: var(--cream); }

        .panel-footer {
          padding: 8px 16px;
          font-size: 9px;
          color: #555;
          letter-spacing: 1px;
          text-transform: uppercase;
          text-align: center;
          border-top: 1px solid var(--border);
        }

        .drag-handle {
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 40px;
          cursor: grab;
          z-index: 1;
        }

        .drag-handle:active { cursor: grabbing; }
      </style>

      <div class="minimize-icon">📖</div>

      <div class="panel-body">
        <div class="drag-handle"></div>

        <div class="panel-header">
          <div class="panel-title">Auto<span>Learn</span></div>
          <button class="btn-min" title="最小化">─</button>
        </div>

        <div class="progress-section">
          <div class="ring-container">
            <svg class="ring-svg" viewBox="0 0 100 100">
              <circle class="ring-bg" cx="50" cy="50" r="42"/>
              <circle class="ring-progress" cx="50" cy="50" r="42"/>
            </svg>
            <div class="ring-center">
              <div class="ring-pct">0</div>
            </div>
          </div>

          <div class="status-info">
            <div class="status-title">READY</div>
            <div class="status-subtitle">点击开始自动学习</div>
            <div class="countdown">
              <span class="countdown-label">NEXT IN</span>
              <span class="countdown-value">5.0s</span>
            </div>
          </div>
        </div>

        <div class="stats-row">
          <div class="stat-item stat-total">
            <div class="stat-num">-</div>
            <div class="stat-label">Total</div>
          </div>
          <div class="stat-item stat-done">
            <div class="stat-num">-</div>
            <div class="stat-label">Done</div>
          </div>
          <div class="stat-item stat-left">
            <div class="stat-num">-</div>
            <div class="stat-label">Left</div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn-main">START</button>
          <button class="btn-secondary" title="刷新统计">↻</button>
        </div>

        <div class="panel-footer">ICOURSE163 AUTOLEARN v1.0.0</div>
      </div>
    `;

    document.body.appendChild(el);
    panel = el;

    // 绑定事件
    el.querySelector('.btn-main').addEventListener('click', toggleAutoLearn);

    el.querySelector('.btn-secondary').addEventListener('click', () => {
      stopAutoLearn();
      totalProcessed = 0;
      updateStatus('READY', '点击开始自动学习');
      el.querySelector('.btn-main').textContent = 'START';
      el.querySelector('.btn-main').classList.remove('active');
    });

    // 最小化按钮
    el.querySelector('.btn-min').addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.add('minimized');
    });

    // 最小化图标 - 恢复
    el.querySelector('.minimize-icon').addEventListener('click', () => {
      el.classList.remove('minimized');
    });

    // 拖拽 - 支持 drag-handle 和 minimize-icon
    let isDragging = false;
    let dragX, dragY;
    const dragHandle = el.querySelector('.drag-handle');
    const minIcon = el.querySelector('.minimize-icon');

    function startDrag(e) {
      isDragging = true;
      const rect = el.getBoundingClientRect();
      dragX = e.clientX - rect.left;
      dragY = e.clientY - rect.top;
      el.style.transition = 'none';
    }

    dragHandle.addEventListener('mousedown', startDrag);
    minIcon.addEventListener('mousedown', startDrag);

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - dragX) + 'px';
      el.style.top = (e.clientY - dragY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      el.style.transition = '';
    });

    // hash 变化时刷新统计
    window.addEventListener('hashchange', () => {
      if (!isDetailView()) {
        setTimeout(() => updateStatus(), 800);
      }
    });

    // 初始统计 - 先展开折叠的章节再统计
    setTimeout(() => {
      expandAndWait(() => {
        updateStatus('READY', '点击开始自动学习');
      });
    }, 500);
  }

  // ============ 初始化 ============
  function isContentPage() {
    return window.location.hash.includes('/learn/content');
  }

  function init() {
    if (!window.location.href.includes('/spoc/learn/')) return;

    function checkAndShow() {
      if (isContentPage()) {
        const items = document.querySelectorAll('.f-icon.lsicon');
        if (items.length > 0) {
          if (!panel) {
            createPanel();
            console.log('[AutoLearn] v1.0.0 loaded');
          } else {
            panel.style.display = '';
          }
          return true;
        }
      } else {
        if (panel) panel.style.display = 'none';
        // 离开课件页面时停止自动学习
        if (isRunning) {
          stopAutoLearn();
        }
      }
      return false;
    }

    const check = setInterval(() => {
      if (checkAndShow()) {
        // 继续监听，但不创建新面板
      }
    }, CONFIG.checkInterval);

    window.addEventListener('hashchange', () => {
      setTimeout(checkAndShow, 500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
