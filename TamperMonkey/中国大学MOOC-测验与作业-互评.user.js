// ==UserScript==
// @name         中国大学MOOC-测验与作业-互评
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  自动互评：将所有空项设为满分，显示图片附件，自动检测次数并完成互评和自评
// @license      GPL-3.0-or-later
// @supportURL   https://github.com/YDX-2147483647/BIT-enhanced/issues
// @author       Y.D.X. (原作者), Harvey (改进)
// @match        https://www.icourse163.org/learn*
// @match        https://www.icourse163.org/spoc/learn*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// 修改说明：
// v1.2.0 (Harvey/Bigzhangbig, 2024-06-02)
// - 新增：自动检测互评进度（已完成/需要份数）
// - 新增：自动循环完成所有互评
// - 新增：自动完成自评
// - 新增：进度显示面板（可拖拽、可最小化）
// - 新增：选择每组最右边的选项（适配不同分值）
// - 改进：只统计 student 开头的行，排除训练题和自评行
// - 保留：原版的全部设为满分、显示图片附件功能

(function () {
  'use strict'

  // ============ 配置 ============
  const CONFIG = {
    checkInterval: 2000,
    reviewDelay: 3000,
    comments: ['完成得很好', '回答正确，继续保持', '思路清晰，解答完整', '不错，继续努力', '无误。'],
  }

  // ============ 状态 ============
  let isRunning = false
  let panel = null
  let reviewCount = 0
  let totalNeeded = 6
  let completedCount = 0
  let selfReviewDone = false

  // ============ 原版功能 ============

  function fill_full_mark () {
    document.querySelectorAll('.j-homework-box .j-list .u-questionItem .u-point .s').forEach(
      (label_list) => {
        if (label_list.querySelector('label:first-child > input').checked) {
          label_list.querySelector('label:last-child > input').checked = true
        }
      }
    )
    document.querySelectorAll('.j-homework-box .j-list .u-questionItem .comment textarea').forEach(
      (textarea) => {
        if (textarea.textLength === 0) {
          textarea.value = '无误。'
        }
      }
    )
  }

  function selectLastRadioOptions () {
    const radioGroups = {}
    const radios = document.querySelectorAll('.j-homework-box input[type="radio"], .u-questionItem input[type="radio"]')

    radios.forEach(radio => {
      const name = radio.getAttribute('name')
      if (name) {
        if (!radioGroups[name]) radioGroups[name] = []
        radioGroups[name].push(radio)
      }
    })

    Object.values(radioGroups).forEach(group => {
      if (group.length > 0) {
        const lastRadio = group[group.length - 1]
        lastRadio.checked = true
        lastRadio.dispatchEvent(new Event('change', { bubbles: true }))
        lastRadio.dispatchEvent(new Event('click', { bubbles: true }))
      }
    })
  }

  function add_button (text, listener, { css_class = 'user-created' } = {}) {
    const header = document.querySelector('#g-body > div.m-learnhead > div')
    if (!header) return

    const button = document.createElement('button')
    button.type = 'button'
    button.classList.add(css_class)
    button.innerText = text
    button.style.padding = '0.5em .2em'
    button.addEventListener('click', listener)

    header.appendChild(button)
  }

  function insert_img (blob, anchor) {
    const img = document.createElement('img')
    const url = URL.createObjectURL(blob)
    img.src = url
    anchor.parentElement.insertBefore(img, anchor)

    img.addEventListener('load', () => {
      URL.revokeObjectURL(url)
    })
  }

  async function fetch_one_attachment (anchor) {
    const response = await fetch(anchor.href)
    const ext = response.url.slice(response.url.lastIndexOf('.'))
    if (['.jpg', '.png', '.jpeg'].includes(ext)) {
      const blob = await response.blob()
      insert_img(blob, anchor)
    } else {
      anchor.textContent += `（${ext}）`
    }
  }

  async function fetch_all_attachments () {
    const anchors = document.querySelectorAll('a.downloadLink')
    return await Promise.all(
      Array.from(anchors).map(fetch_one_attachment)
    )
  }

  // ============ 新增功能 ============

  function isReviewPage () {
    const hasRadio = document.querySelector('input[type="radio"]') !== null
    const hasTextarea = document.querySelector('.j-textarea, textarea') !== null
    const hasReviewModule = document.body.innerText.includes('互评模块') ||
      document.body.innerText.includes('请给予评分')
    return hasRadio && hasTextarea && hasReviewModule
  }

  function getReviewProgress () {
    const info = {
      required: 6, // 默认值，会被动态解析覆盖
      completed: 0,
      remaining: 6,
      selfReviewDone: false,
      hasPeerReview: false
    }

    const allText = document.body.innerText

    if (!allText.includes('互评') && !allText.includes('自评')) {
      return info
    }

    info.hasPeerReview = true

    // 动态解析需要的互评份数
    const requiredMatch = allText.match(/至少为\s*(\d+)\s*份/) || allText.match(/需要互评\s*(\d+)\s*份/)
    if (requiredMatch) {
      info.required = parseInt(requiredMatch[1], 10)
    }

    // 检测已完成的互评份数 - 只统计 student 开头的行
    const rows = document.querySelectorAll('table tr, .u-table tr')
    let completedInTable = 0
    rows.forEach(row => {
      const cells = row.querySelectorAll('td, .td')
      if (cells.length >= 2) {
        const nameText = cells[0]?.textContent?.trim() || ''
        const scoreText = cells[1]?.textContent?.trim() || ''
        if (nameText.startsWith('student') && /^\d+$/.test(scoreText)) {
          completedInTable++
        }
      }
    })
    info.completed = completedInTable

    // 检测自评状态
    const selfReviewLinks = document.querySelectorAll('a')
    let selfReviewLinkFound = false
    selfReviewLinks.forEach(link => {
      const text = link.textContent?.trim()
      if (text && text.includes('点击自评')) {
        selfReviewLinkFound = true
      }
    })
    info.selfReviewDone = !selfReviewLinkFound

    info.remaining = Math.max(0, info.required - info.completed)
    return info
  }

  function findReviewableItems () {
    const links = document.querySelectorAll('a')
    const reviewLinks = []

    links.forEach(link => {
      const text = link.textContent?.trim()
      if (text && text.includes('继续进行互评') || (text && text.includes('开始进行互评'))) {
        const row = link.closest('tr')
        if (row) {
          const isSelfReview = row.textContent.includes('mooc') ||
            row.textContent.includes('点击自评')
          if (!isSelfReview) {
            reviewLinks.push(link)
          }
        } else {
          reviewLinks.push(link)
        }
      }
    })

    return reviewLinks
  }

  function findSelfReviewLink () {
    const links = document.querySelectorAll('a')
    for (const link of links) {
      const text = link.textContent?.trim()
      if (text && text.includes('点击自评')) {
        return link
      }
    }
    return null
  }

  function performReview () {
    selectLastRadioOptions()

    const textareas = document.querySelectorAll('.j-textarea, textarea')
    textareas.forEach(ta => {
      if (!ta.value || ta.value.trim() === '') {
        const randomComment = CONFIG.comments[Math.floor(Math.random() * CONFIG.comments.length)]
        ta.value = randomComment
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    setTimeout(() => {
      if (!isRunning) return // STOP 后不再提交
      const submitBtn = document.querySelector('.j-submitbtn, button[type="submit"]')
      if (submitBtn) {
        submitBtn.click()
        reviewCount++
      } else {
        const link = Array.from(document.querySelectorAll('a')).find(l => l.textContent?.trim() === '提交')
        if (link) {
          link.click()
          reviewCount++
        }
      }
    }, 500)

    return true
  }

  function performSelfReview () {
    selectLastRadioOptions()

    const textareas = document.querySelectorAll('.j-textarea, textarea')
    textareas.forEach(ta => {
      if (!ta.value || ta.value.trim() === '') {
        ta.value = '自评完成'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    setTimeout(() => {
      if (!isRunning) return // STOP 后不再提交
      const submitBtn = document.querySelector('.j-submitbtn, button[type="submit"]')
      if (submitBtn) {
        submitBtn.click()
        selfReviewDone = true
      } else {
        const link = Array.from(document.querySelectorAll('a')).find(l => l.textContent?.trim() === '提交')
        if (link) {
          link.click()
          selfReviewDone = true
        }
      }
    }, 500)

    return true
  }

  function goBackToList () {
    const backBtn = document.querySelector('.j-backbtn')
    if (backBtn) {
      backBtn.click()
    } else {
      const link = Array.from(document.querySelectorAll('a')).find(l => l.textContent?.trim().includes('返回'))
      if (link) link.click()
    }
  }

  // ============ 核心逻辑 ============

  function startAutoReview () {
    if (isRunning) return

    isRunning = true
    reviewCount = 0

    const info = getReviewProgress()
    totalNeeded = info.remaining
    completedCount = info.completed
    selfReviewDone = info.selfReviewDone

    if (totalNeeded === 0 && selfReviewDone) {
      updateStatus('ALL CLEAR', '互评和自评已完成')
      stopAutoReview()
      return
    }

    updateStatus('STARTING', `需互评 ${totalNeeded} 份，自评${selfReviewDone ? '已完成' : '未完成'}`)
    processNextReview()
  }

  function processNextReview () {
    if (!isRunning) return

    if (isReviewPage()) {
      const reviewModule = document.querySelector('.j-reviewModule, [class*="review"]')
      if (!reviewModule && !document.body.innerText.includes('请给予评分')) {
        goBackToList()
        setTimeout(() => processNextReview(), CONFIG.reviewDelay)
        return
      }

      updateStatus('REVIEWING', `正在评价第 ${reviewCount + 1}/${totalNeeded} 份`)

      setTimeout(() => {
        performReview()

        setTimeout(() => {
          if (!isReviewPage()) {
            processNextReview()
          } else {
            goBackToList()
            setTimeout(() => processNextReview(), CONFIG.reviewDelay)
          }
        }, CONFIG.reviewDelay)
      }, 1500)

      return
    }

    const info = getReviewProgress()
    completedCount = info.completed
    selfReviewDone = info.selfReviewDone
    totalNeeded = Math.max(0, info.required - completedCount)

    if (totalNeeded === 0) {
      if (!selfReviewDone) {
        updateStatus('SELF REVIEW', '开始自评')
        const selfLink = findSelfReviewLink()
        if (selfLink) {
          selfLink.click()
          setTimeout(() => {
            if (isReviewPage()) {
              performSelfReview()
              setTimeout(() => processNextReview(), CONFIG.reviewDelay)
            }
          }, 2000)
          return
        }
      }

      stopAutoReview()
      updateStatus('COMPLETE', `互评 ${completedCount} 份，自评已完成`)
      pulsePanel('success')
      return
    }

    const reviewLinks = findReviewableItems()

    if (reviewLinks.length > 0) {
      updateStatus('FOUND', `找到可评价作业，开始第 ${reviewCount + 1}/${totalNeeded} 份`)
      reviewLinks[0].click()
      setTimeout(() => processNextReview(), 2000)
    } else {
      updateStatus('WAITING', `已完成 ${completedCount}/${info.required} 份，查找可评价作业...`)
      window.scrollBy(0, 300)
      setTimeout(() => processNextReview(), CONFIG.checkInterval)
    }
  }

  function stopAutoReview () {
    isRunning = false
    updateBtnState()
  }

  // ============ UI ============

  function updateStatus (title, subtitle) {
    if (!panel) return

    const titleEl = panel.querySelector('.status-title')
    const subEl = panel.querySelector('.status-subtitle')
    const progressEl = panel.querySelector('.progress-value')

    if (titleEl && title) titleEl.textContent = title
    if (subEl) subEl.textContent = subtitle || ''

    if (progressEl) {
      const info = getReviewProgress()
      progressEl.textContent = `${info.completed}/${info.required}`
    }
  }

  function updateBtnState () {
    const btn = panel?.querySelector('.btn-main')
    if (btn) {
      btn.textContent = isRunning ? 'STOP' : 'START'
      btn.classList.toggle('active', isRunning)
    }
  }

  function pulsePanel (type) {
    if (!panel) return
    panel.classList.add(`pulse-${type}`)
    setTimeout(() => panel.classList.remove(`pulse-${type}`), 1200)
  }

  function createPanel () {
    const el = document.createElement('div')
    el.className = 'peer-review-panel'
    el.innerHTML = `
      <style>
        .peer-review-panel {
          --bg: #1a1a1a;
          --card: #232323;
          --accent: #8e44ad;
          --accent2: #9b59b6;
          --cream: #f5f0e8;
          --gold: #f39c12;
          --green: #27ae60;
          --text: #e8e4dc;
          --muted: #888;
          --border: #333;

          position: fixed;
          top: 24px;
          left: 24px;
          width: 300px;
          background: var(--bg);
          border: 3px solid var(--border);
          border-radius: 2px;
          font-family: 'Space Mono', 'Courier New', monospace;
          color: var(--text);
          z-index: 999999;
          box-shadow:
            6px 6px 0 rgba(142, 68, 173, 0.3),
            0 15px 40px rgba(0,0,0,0.4);
          overflow: hidden;
        }

        .peer-review-panel::before {
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

        .peer-review-panel.minimized {
          width: 50px;
          height: 50px;
          border-radius: 50%;
          cursor: grab;
          overflow: hidden;
        }

        .peer-review-panel.minimized .panel-body { display: none; }
        .peer-review-panel.minimized .minimize-icon { display: flex; }

        .peer-review-panel.pulse-success { animation: pulseGreen 1.2s ease; }

        @keyframes pulseGreen {
          0%, 100% { border-color: var(--border); }
          30% { border-color: var(--green); box-shadow: 0 0 20px rgba(39,174,96,0.3); }
        }

        .minimize-icon {
          display: none;
          width: 100%;
          height: 100%;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          background: var(--accent);
          cursor: grab;
        }

        .panel-body { position: relative; }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px 8px;
          border-bottom: 1px solid var(--border);
        }

        .panel-title {
          font-size: 14px;
          font-weight: 400;
          letter-spacing: 0.5px;
          color: var(--cream);
        }

        .panel-title span { color: var(--accent); }

        .btn-min {
          width: 24px;
          height: 24px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 2px;
          color: var(--muted);
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
          position: relative;
          z-index: 2;
        }

        .btn-min:hover { background: var(--accent); color: white; border-color: var(--accent); }

        .status-section {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
        }

        .status-title {
          font-size: 14px;
          color: var(--cream);
          margin-bottom: 4px;
        }

        .status-subtitle {
          font-size: 11px;
          color: var(--muted);
          letter-spacing: 0.5px;
        }

        .progress-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          background: var(--card);
          border-bottom: 1px solid var(--border);
        }

        .progress-label {
          font-size: 11px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .progress-value {
          font-size: 16px;
          color: var(--gold);
          font-weight: 700;
        }

        .btn-row {
          display: flex;
          padding: 10px 14px;
          gap: 8px;
          background: var(--card);
        }

        .btn-main {
          flex: 1;
          padding: 10px;
          background: var(--accent);
          border: 2px solid var(--accent);
          border-radius: 2px;
          color: white;
          font-family: 'Space Mono', monospace;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 2px;
          cursor: pointer;
          transition: all 0.2s;
          text-transform: uppercase;
        }

        .btn-main:hover { background: var(--accent2); border-color: var(--accent2); }

        .btn-main.active {
          background: transparent;
          color: var(--accent);
          animation: blinkBorder 1.5s infinite;
        }

        @keyframes blinkBorder {
          0%, 100% { border-color: var(--accent); }
          50% { border-color: var(--gold); }
        }

        .panel-footer {
          padding: 6px 14px;
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
          height: 35px;
          cursor: grab;
          z-index: 1;
        }

        .drag-handle:active { cursor: grabbing; }
      </style>

      <div class="minimize-icon">📝</div>

      <div class="panel-body">
        <div class="drag-handle"></div>

        <div class="panel-header">
          <div class="panel-title">Peer<span>Review</span></div>
          <button class="btn-min" title="最小化">─</button>
        </div>

        <div class="status-section">
          <div class="status-title">READY</div>
          <div class="status-subtitle">点击开始自动互评</div>
        </div>

        <div class="progress-row">
          <span class="progress-label">Progress</span>
          <span class="progress-value">0/6</span>
        </div>

        <div class="btn-row">
          <button class="btn-main">START</button>
        </div>

        <div class="panel-footer">AUTO PEER REVIEW v1.2.0</div>
      </div>
    `

    document.body.appendChild(el)
    panel = el

    // 最小化按钮
    el.querySelector('.btn-min').addEventListener('click', (e) => {
      e.stopPropagation()
      el.classList.add('minimized')
    })

    // 最小化图标 - 恢复
    el.querySelector('.minimize-icon').addEventListener('click', () => {
      el.classList.remove('minimized')
    })

    // 主按钮
    el.querySelector('.btn-main').addEventListener('click', () => {
      if (isRunning) {
        stopAutoReview()
        updateStatus('STOPPED', '已停止')
      } else {
        startAutoReview()
      }
      updateBtnState()
    })

    // 拖拽 - 支持 drag-handle 和 minimize-icon
    let isDragging = false
    let dragX, dragY
    const dragHandle = el.querySelector('.drag-handle')
    const minimizeIcon = el.querySelector('.minimize-icon')

    function startDrag(e) {
      isDragging = true
      const rect = el.getBoundingClientRect()
      dragX = e.clientX - rect.left
      dragY = e.clientY - rect.top
      el.style.transition = 'none'
    }

    dragHandle.addEventListener('mousedown', startDrag)
    minimizeIcon.addEventListener('mousedown', startDrag)

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return
      el.style.left = (e.clientX - dragX) + 'px'
      el.style.top = (e.clientY - dragY) + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    })

    document.addEventListener('mouseup', () => {
      isDragging = false
      el.style.transition = ''
    })

    setTimeout(() => {
      const info = getReviewProgress()
      if (info.hasPeerReview) {
        updateStatus('DETECTED', `互评 ${info.completed}/${info.required}，自评${info.selfReviewDone ? '✓' : '✗'}`)
        totalNeeded = info.remaining
        selfReviewDone = info.selfReviewDone
      } else {
        updateStatus('READY', '请进入作业互评页面')
      }
    }, 1000)
  }

  // ============ 主函数 ============

  function main () {
    const hash = window.location.hash
    // 在测验与作业 tab 或具体作业页面显示
    const isHwPage = /#\/learn\/hw(\?id=\d+)?/.test(hash) || hash.includes('/learn/testlist')

    if (isHwPage) {
      if (/#\/learn\/hw\?id=\d+/.test(hash)) {
        const existed_button = document.querySelector('button.fill-full-mark')
        if (!existed_button) {
          add_button('全部设为满分', fill_full_mark, { css_class: 'fill-full-mark' })
          add_button('下载图片附件', () => fetch_all_attachments(), { css_class: 'fetch-all-attachments' })
        }
      }

      if (!panel) {
        createPanel()
      }

      const info = getReviewProgress()
      if (info.hasPeerReview && !isRunning) {
        totalNeeded = info.remaining
        selfReviewDone = info.selfReviewDone
        updateStatus('DETECTED', `互评 ${info.completed}/${info.required}，自评${info.selfReviewDone ? '✓' : '✗'}`)
      }
    } else {
      // 隐藏面板
      if (panel) {
        panel.style.display = 'none'
      }
      document.querySelector('button.fill-full-mark')?.remove()
      document.querySelector('button.fetch-all-attachments')?.remove()
    }

    // 如果在作业页面，显示面板
    if (isHwPage && panel) {
      panel.style.display = ''
    } else {
      // 离开作业页面时停止自动互评
      if (isRunning) {
        stopAutoReview()
      }
    }
  }

  // ============ 初始化 ============

  function init () {
    if (!window.location.href.includes('icourse163.org')) return

    console.log('[PeerReview] v1.2.0 loaded')

    setTimeout(() => {
      main()

      window.addEventListener('hashchange', () => {
        setTimeout(main, 1000)
      })
    }, 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
