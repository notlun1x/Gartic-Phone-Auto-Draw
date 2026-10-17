// ==UserScript==
// @name         Gartic Phone DrawBot
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Automated drawing bot with WebSocket interception, image loading, color quantization, preview and progress indicator
// @author       NotLun1x
// @match        https://garticphone.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    // Verbose per-packet logging; switch on when debugging protocol issues
    const DEBUG = false;
    function debugLog(...args) {
        if (DEBUG) console.log(...args);
    }

    // --- Event & Error Logging Helpers ---
    const LOG_MAX_LINES = 50;
    function formatLogArg(arg) {
        if (arg instanceof Error) return arg.message;
        if (typeof arg === 'object' && arg !== null) {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
        }
        return String(arg);
    }
    function logToPanel(msg, isError = false) {
        try {
            const container = document.getElementById('db-log-container');
            const content = document.getElementById('db-log-content');
            if (!container || !content) return;
            container.style.display = 'block';
            const line = document.createElement('div');
            line.style.color = isError ? '#ef4444' : '#cbd5e1';
            // textContent: messages may contain markup from URLs or game data
            line.textContent = msg;
            content.appendChild(line);
            while (content.childElementCount > LOG_MAX_LINES) content.firstElementChild.remove();
            container.scrollTop = container.scrollHeight;
        } catch (e) {
            console.warn('[DrawBot] Log output error:', e);
        }
    }
    // The panel shows only this script's errors, not the game's own ones.
    // Userscript managers put the script name into its URL, so it shows up in filename/stack.
    function isOwnError(filename, stack) {
        return /drawbot/i.test(String(filename || '')) || /drawbot/i.test(String(stack || ''));
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('error', (e) => {
            if (!isOwnError(e.filename, e.error && e.error.stack)) return;
            logToPanel(`Error: ${e.message} (line ${e.lineno})`, true);
        });
        window.addEventListener('unhandledrejection', (e) => {
            if (!isOwnError('', e.reason && e.reason.stack)) return;
            logToPanel(`Promise Rejection: ${formatLogArg(e.reason)}`, true);
        });

        const originalConsoleError = console.error;
        console.error = function (...args) {
            originalConsoleError.apply(console, args);
            if (typeof args[0] === 'string' && args[0].startsWith('[DrawBot]')) {
                logToPanel(args.map(formatLogArg).join(' '), true);
            }
        };
    }

    const SETTINGS_KEY = 'drawbot_settings_v1';
    function loadInitialCFG() {
        const defaults = {
            downscale: 4,
            denoise: false,
            packetDelay: 127,
            fillPPS: 8,
            fillBg: false,
            useBridge: true,
            maxBridgeLength: 50,
            colorsMode: '8',
            currentTurnId: 0
        };
        try {
            const data = localStorage.getItem(SETTINGS_KEY);
            if (data) {
                const saved = JSON.parse(data);
                defaults.downscale = parseInt(saved.scale, 10) || 4;
                defaults.packetDelay = parseInt(saved.delay, 10) || 127;
                defaults.fillPPS = parseInt(saved.fillPPS, 10) || 8;
                defaults.fillBg = saved.fillBg !== undefined ? saved.fillBg : false;
                defaults.useBridge = saved.useBridge !== undefined ? saved.useBridge : true;
                defaults.maxBridgeLength = parseInt(saved.bridgeLen, 10) || 50;
                defaults.colorsMode = saved.colorsMode || '8';
            }
        } catch (e) { }
        return defaults;
    }
    const CFG = loadInitialCFG();
    const FAST_FILL_MAX_FRAME_CHARS = 500000;
    const HEX_COLOR_RE = /^#[0-9A-F]{6}$/i;

    let wsInstance = null;
    let wsPrefix = '42[2,7,';
    let isDrawing = false;
    let cancelFlag = false;
    let isPaused = false;
    let currentImageSrc = '';
    // Bot stroke IDs live far above the game's own small IDs, so manual strokes never collide with them
    const SAFE_ID_FLOOR = 100000;
    function randomSafeStrokeStart() {
        return SAFE_ID_FLOOR + Math.floor(Math.random() * 100000);
    }
    let strokeIdCounter = randomSafeStrokeStart();

    // --- Layout and Custom Scale State ---
    let layoutMode = 'stretch'; // 'stretch', 'center', 'custom'
    let customX = 0;   // 0 to 768
    let customY = 0;   // 0 to 448
    let customW = 384; // default width
    let customH = 224; // default height
    let draftImg = null;
    let isDraggingImage = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let imgStartX = 0;
    let imgStartY = 0;
    let imgStartW = 0;
    let imgStartH = 0;
    let activeDragAction = null; // 'move', 'resize-TL', 'resize-TR', 'resize-BL', 'resize-BR'
    let isApplied = false;

    const GARTIC_PALETTE = [
        { r: 0, g: 0, b: 0 },         // Black
        { r: 102, g: 102, b: 102 },   // Dark Grey
        { r: 0, g: 80, b: 205 },      // Dark Blue
        { r: 255, g: 255, b: 255 },   // White
        { r: 170, g: 170, b: 170 },   // Light Grey
        { r: 38, g: 201, b: 255 },    // Light Blue
        { r: 1, g: 116, b: 32 },      // Dark Green
        { r: 153, g: 0, b: 0 },       // Dark Red
        { r: 150, g: 65, b: 18 },     // Brown
        { r: 17, g: 176, b: 60 },     // Light Green
        { r: 255, g: 0, b: 19 },      // Red
        { r: 255, g: 120, b: 41 },    // Orange
        { r: 176, g: 112, b: 28 },    // Dark Yellow
        { r: 153, g: 0, b: 78 },      // Dark Pink
        { r: 203, g: 90, b: 87 },     // Muted Red
        { r: 255, g: 193, b: 38 },    // Yellow
        { r: 255, g: 0, b: 143 },     // Pink
        { r: 254, g: 175, b: 168 }    // Light Pink
    ];

    // --- Turn (round) ID ---
    // Sent as "t" in every drawing packet. Auto-captured from socket traffic
    // unless "Auto" is switched off in the panel and the value is set by hand.
    let turnIdAuto = true;
    function setCapturedTurnId(value, source) {
        if (!turnIdAuto) return;
        debugLog(`[DrawBot] Captured turnId (${source}):`, value);
        applyTurnId(value);
        const input = document.getElementById('db-turn-id');
        // Do not overwrite the field while the user is typing in it
        if (input && document.activeElement !== input) input.value = turnIdToRound(value);
    }

    // Stroke IDs only have to be unique within a round, so a new round starts a fresh sequence.
    // Other socket events (chat, timers, state updates) no longer reset it mid-round.
    function applyTurnId(value) {
        if (value === CFG.currentTurnId) return;
        CFG.currentTurnId = value;
        strokeIdCounter = randomSafeStrokeStart();
        console.log(`[DrawBot] Round ${turnIdToRound(value)}: stroke IDs restart at ${strokeIdCounter}.`);
    }

    // turnId is 0-based in packets, while the game counts rounds from 1
    function turnIdToRound(turnId) {
        return turnId + 1;
    }
    function roundToTurnId(round) {
        return round - 1;
    }

    // --- WebSocket Interceptor ---
    function handleIncomingSocketData(data) {
        if (typeof data !== 'string') return;
        try {
            const jsonStart = data.indexOf('{');
            if (jsonStart !== -1) {
                const jsonStr = data.substring(jsonStart, data.lastIndexOf('}') + 1);
                const packet = JSON.parse(jsonStr);
                if (packet) {
                    if (typeof packet.turnNum === 'number') {
                        setCapturedTurnId(packet.turnNum, 'incoming');
                    }
                    if (packet.data && typeof packet.data.turnNum === 'number') {
                        setCapturedTurnId(packet.data.turnNum, 'incoming data');
                    }
                }
            }
        } catch (e) { }
    }

    // Sockets that already have the incoming-message listener attached
    const hookedSockets = new WeakSet();
    function hookIncomingMessages(ws) {
        if (!ws || hookedSockets.has(ws)) return;
        hookedSockets.add(ws);
        try {
            // addEventListener does not interfere with the game's own onmessage handler
            ws.addEventListener('message', function (event) {
                handleIncomingSocketData(event.data);
            });
        } catch (err) {
            console.error('[DrawBot] Error listening to incoming messages:', err);
        }
    }

    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.startsWith('42[')) {
            // Fallback: socket created before the constructor wrapper was installed
            hookIncomingMessages(this);
            if (wsInstance !== this || !this.__drawbotLinked) {
                this.__drawbotLinked = true;
                wsInstance = this;
                console.log('[DrawBot] WebSocket linked successfully!');
                updateStatus('Socket ready. Select a file and click Start.', '#10b981');
            }

            // Dynamically capture the socket message prefix
            const prefixMatch = data.match(/^(42\[\d+,\d+,)\{"t":/);
            if (prefixMatch) {
                if (wsPrefix !== prefixMatch[1]) {
                    wsPrefix = prefixMatch[1];
                    console.log('[DrawBot] Captured socket prefix:', wsPrefix);
                }
            } else {
                const genericMatch = data.match(/^42\[(\d+),/);
                if (genericMatch) {
                    const channelId = genericMatch[1];
                    const newPrefix = `42[${channelId},7,`;
                    if (wsPrefix !== newPrefix) {
                        wsPrefix = newPrefix;
                        console.log('[DrawBot] Dynamically updated socket prefix to:', wsPrefix);
                    }
                }
            }

            // Capture the last stroke ID and turn ID sent by the user
            try {
                const jsonStart = data.indexOf('{');
                if (jsonStart !== -1) {
                    const jsonStr = data.substring(jsonStart, data.lastIndexOf('}') + 1);
                    const packet = JSON.parse(jsonStr);
                    if (packet) {
                        if (typeof packet.t === 'number') {
                            setCapturedTurnId(packet.t, 'outgoing');
                        }
                        if (packet.v && Array.isArray(packet.v)) {
                            const strokeId = packet.v[1];
                            if (typeof strokeId === 'number') {
                                // Never move the counter backwards within a turn: the game's own IDs are small,
                                // so lowering it would make the next bot run reuse IDs it already sent.
                                // A new turn is handled by applyTurnId().
                                strokeIdCounter = Math.max(strokeIdCounter, strokeId + 1, SAFE_ID_FLOOR);
                                debugLog('[DrawBot] Captured strokeId. Next:', strokeIdCounter);
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore parsing errors
            }
        }
        return originalSend.apply(this, arguments);
    };

    const originalWebSocket = window.WebSocket;
    window.WebSocket = function (...args) {
        const ws = new originalWebSocket(...args);
        wsInstance = ws;
        hookIncomingMessages(ws);
        return ws;
    };
    window.WebSocket.prototype = originalWebSocket.prototype;

    // --- Helpers ---
    let timerWorker = null;
    const pendingSleeps = new Map();
    let sleepId = 0;

    try {
        const workerCode = `
            self.onmessage = function(e) {
                if (e.data.action === 'start') {
                    setTimeout(() => {
                        self.postMessage({ id: e.data.id });
                    }, e.data.ms);
                }
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        timerWorker = new Worker(URL.createObjectURL(blob));
        timerWorker.onmessage = function (e) {
            const resolve = pendingSleeps.get(e.data.id);
            if (resolve) {
                pendingSleeps.delete(e.data.id);
                resolve();
            }
        };
    } catch (err) {
        console.error('[DrawBot] Failed to create Web Worker for timers:', err);
    }

    const sleep = ms => new Promise(resolve => {
        if (timerWorker) {
            const id = sleepId++;
            pendingSleeps.set(id, resolve);
            timerWorker.postMessage({ action: 'start', id, ms });
        } else {
            setTimeout(resolve, ms);
        }
    });

    function clampCustomBounds() {
        customW = Math.max(10, Math.min(768, customW));
        customH = Math.max(10, Math.min(448, customH));
        customX = Math.max(0, Math.min(768 - customW, customX));
        customY = Math.max(0, Math.min(448 - customH, customY));
    }

    function updateSliders() {
        const wSlider = document.getElementById('db-custom-w');
        const hSlider = document.getElementById('db-custom-h');
        const xSlider = document.getElementById('db-custom-x');
        const ySlider = document.getElementById('db-custom-y');
        
        if (wSlider) {
            wSlider.value = customW;
            document.getElementById('db-val-w').textContent = Math.round(customW);
        }
        if (hSlider) {
            hSlider.value = customH;
            document.getElementById('db-val-h').textContent = Math.round(customH);
        }
        if (xSlider) {
            xSlider.max = 768 - customW;
            xSlider.value = customX;
            document.getElementById('db-val-x').textContent = Math.round(customX);
        }
        if (ySlider) {
            ySlider.max = 448 - customH;
            ySlider.value = customY;
            document.getElementById('db-val-y').textContent = Math.round(customY);
        }
    }

    function drawDraftPreview() {
        const pCanvas = document.getElementById('db-preview-canvas');
        if (!pCanvas || !currentImageSrc) return;
        const pContainer = document.getElementById('db-preview-container');
        if (pContainer) {
            pContainer.style.display = 'flex';
        }
        const step = parseInt(document.getElementById('db-scale').value, 10);
        const w = Math.round(768 / step);
        const h = Math.round(448 / step);
        pCanvas.width = w;
        pCanvas.height = h;
        const ctx = pCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        
        // Draw faint outline of the Gartic Phone drawing boundaries
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, w, h);
        
        if (draftImg && draftImg.complete) {
            const cx = customX / step;
            const cy = customY / step;
            const cw = customW / step;
            const ch = customH / step;
            ctx.drawImage(draftImg, cx, cy, cw, ch);
            
            // Bounding box border
            ctx.strokeStyle = '#8b5cf6';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(cx, cy, cw, ch);
            
            // Corner handles (constant visual size of 12px on screen, so half-size is 6px on screen)
            ctx.fillStyle = '#8b5cf6';
            const rect = pCanvas.getBoundingClientRect();
            const hs = (6 * w) / rect.width;
            
            ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2); // TL
            ctx.fillRect(cx + cw - hs, cy - hs, hs * 2, hs * 2); // TR
            ctx.fillRect(cx - hs, cy + ch - hs, hs * 2, hs * 2); // BL
            ctx.fillRect(cx + cw - hs, cy + ch - hs, hs * 2, hs * 2); // BR
        }
        
        const infoEl = document.getElementById('db-preview-info');
        if (infoEl) {
            infoEl.innerHTML = `<span style="color: #fbbf24; font-weight: bold;">[Draft Mode] Drag corners to resize or body to move.<br>Click "Apply & Render Preview" to verify drawing.</span>`;
        }
    }

    function handleCanvasMouseDown(e) {
        if (layoutMode !== 'custom' || !draftImg) return;
        const pCanvas = document.getElementById('db-preview-canvas');
        if (!pCanvas) return;
        const rect = pCanvas.getBoundingClientRect();
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const workX = (mouseX / rect.width) * 768;
        const workY = (mouseY / rect.height) * 448;
        
        // Grab threshold of 24 screen pixels (extremely easy to grab corners):
        const handleThreshold = 24 * (768 / rect.width);
        
        const distTL = Math.hypot(workX - customX, workY - customY);
        const distTR = Math.hypot(workX - (customX + customW), workY - customY);
        const distBL = Math.hypot(workX - customX, workY - (customY + customH));
        const distBR = Math.hypot(workX - (customX + customW), workY - (customY + customH));
        
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        imgStartX = customX;
        imgStartY = customY;
        imgStartW = customW;
        imgStartH = customH;
        
        if (distTL < handleThreshold) {
            activeDragAction = 'resize-TL';
        } else if (distTR < handleThreshold) {
            activeDragAction = 'resize-TR';
        } else if (distBL < handleThreshold) {
            activeDragAction = 'resize-BL';
        } else if (distBR < handleThreshold) {
            activeDragAction = 'resize-BR';
        } else if (workX >= customX && workX <= customX + customW &&
                   workY >= customY && workY <= customY + customH) {
            activeDragAction = 'move';
        } else {
            activeDragAction = null;
            return;
        }
        
        isDraggingImage = true;
        document.addEventListener('mousemove', handleCanvasMouseMove);
        document.addEventListener('mouseup', handleCanvasMouseUp);
    }

    function handleCanvasMouseMove(e) {
        if (!isDraggingImage || !activeDragAction) return;
        const pCanvas = document.getElementById('db-preview-canvas');
        if (!pCanvas) return;
        const rect = pCanvas.getBoundingClientRect();
        
        const deltaPageX = e.clientX - dragStartX;
        const deltaPageY = e.clientY - dragStartY;
        
        const deltaX = (deltaPageX / rect.width) * 768;
        const deltaY = (deltaPageY / rect.height) * 448;
        
        if (activeDragAction === 'move') {
            customX = Math.max(0, Math.min(768 - customW, imgStartX + deltaX));
            customY = Math.max(0, Math.min(448 - customH, imgStartY + deltaY));
        } else if (activeDragAction === 'resize-BR') {
            customW = Math.max(10, Math.min(768 - customX, imgStartW + deltaX));
            customH = Math.max(10, Math.min(448 - customY, imgStartH + deltaY));
        } else if (activeDragAction === 'resize-BL') {
            customX = Math.max(0, Math.min(imgStartX + imgStartW - 10, imgStartX + deltaX));
            customW = imgStartX + imgStartW - customX;
            customH = Math.max(10, Math.min(448 - customY, imgStartH + deltaY));
        } else if (activeDragAction === 'resize-TR') {
            customY = Math.max(0, Math.min(imgStartY + imgStartH - 10, imgStartY + deltaY));
            customH = imgStartY + imgStartH - customY;
            customW = Math.max(10, Math.min(768 - customX, imgStartW + deltaX));
        } else if (activeDragAction === 'resize-TL') {
            customX = Math.max(0, Math.min(imgStartX + imgStartW - 10, imgStartX + deltaX));
            customY = Math.max(0, Math.min(imgStartY + imgStartH - 10, imgStartY + deltaY));
            customW = imgStartX + imgStartW - customX;
            customH = imgStartY + imgStartH - customY;
        }
        
        clampCustomBounds();
        updateSliders();
        drawDraftPreview();
        isApplied = false;
    }

    function handleCanvasMouseUp() {
        isDraggingImage = false;
        activeDragAction = null;
        document.removeEventListener('mousemove', handleCanvasMouseMove);
        document.removeEventListener('mouseup', handleCanvasMouseUp);
    }

    function handleCanvasMouseMoveNoDrag(e) {
        if (layoutMode !== 'custom' || isDraggingImage || !draftImg) return;
        const pCanvas = document.getElementById('db-preview-canvas');
        if (!pCanvas) return;
        const rect = pCanvas.getBoundingClientRect();
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const workX = (mouseX / rect.width) * 768;
        const workY = (mouseY / rect.height) * 448;
        
        // Match hover cursor detection threshold (24 screen pixels):
        const handleThreshold = 24 * (768 / rect.width);
        
        const distTL = Math.hypot(workX - customX, workY - customY);
        const distTR = Math.hypot(workX - (customX + customW), workY - customY);
        const distBL = Math.hypot(workX - customX, workY - (customY + customH));
        const distBR = Math.hypot(workX - (customX + customW), workY - (customY + customH));
        
        if (distTL < handleThreshold || distBR < handleThreshold) {
            pCanvas.style.cursor = 'nwse-resize';
        } else if (distTR < handleThreshold || distBL < handleThreshold) {
            pCanvas.style.cursor = 'nesw-resize';
        } else if (workX >= customX && workX <= customX + customW &&
                   workY >= customY && workY <= customY + customH) {
            pCanvas.style.cursor = 'move';
        } else {
            pCanvas.style.cursor = 'default';
        }
    }

    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    }

    function hexToRgb(hex) {
        const bigint = parseInt(hex.slice(1), 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255
        };
    }

    function getDistance(c1, c2) {
        const rMean = (c1.r + c2.r) / 2;
        const r = c1.r - c2.r;
        const g = c1.g - c2.g;
        const b = c1.b - c2.b;
        return (2 + rMean / 256) * r * r + 4 * g * g + (2 + (255 - rMean) / 256) * b * b;
    }

    function quantize(pixels, maxColors) {
        if (pixels.length <= maxColors) {
            return pixels.map(p => ({ r: p.r, g: p.g, b: p.b }));
        }

        pixels.sort((a, b) => b.count - a.count);

        let clusters = [];
        let threshold = 35 * 35 * 3; // Adjusted for redmean perceptual distance scale

        for (let p of pixels) {
            let added = false;
            for (let c of clusters) {
                if (getDistance(p, c.center) < threshold) {
                    c.sumR += p.r * p.count;
                    c.sumG += p.g * p.count;
                    c.sumB += p.b * p.count;
                    c.totalCount += p.count;
                    c.center.r = Math.round(c.sumR / c.totalCount);
                    c.center.g = Math.round(c.sumG / c.totalCount);
                    c.center.b = Math.round(c.sumB / c.totalCount);
                    added = true;
                    break;
                }
            }

            if (!added) {
                if (clusters.length < maxColors) {
                    clusters.push({
                        center: { r: p.r, g: p.g, b: p.b },
                        sumR: p.r * p.count,
                        sumG: p.g * p.count,
                        sumB: p.b * p.count,
                        totalCount: p.count
                    });
                } else {
                    let closest = null;
                    let minDist = Infinity;
                    for (let c of clusters) {
                        let dist = getDistance(p, c.center);
                        if (dist < minDist) {
                            minDist = dist;
                            closest = c;
                        }
                    }
                    closest.sumR += p.r * p.count;
                    closest.sumG += p.g * p.count;
                    closest.sumB += p.b * p.count;
                    closest.totalCount += p.count;
                    closest.center.r = Math.round(closest.sumR / closest.totalCount);
                    closest.center.g = Math.round(closest.sumG / closest.totalCount);
                    closest.center.b = Math.round(closest.sumB / closest.totalCount);
                }
            }
        }

        // K-Means refinement passes (3 iterations)
        let centers = clusters.map(c => ({ r: c.center.r, g: c.center.g, b: c.center.b }));
        for (let iter = 0; iter < 3; iter++) {
            const nextSums = Array.from({ length: centers.length }, () => ({ sumR: 0, sumG: 0, sumB: 0, totalCount: 0 }));

            for (const p of pixels) {
                let closestIdx = 0;
                let minDist = Infinity;
                for (let i = 0; i < centers.length; i++) {
                    const dist = getDistance(p, centers[i]);
                    if (dist < minDist) {
                        minDist = dist;
                        closestIdx = i;
                    }
                }
                const s = nextSums[closestIdx];
                s.sumR += p.r * p.count;
                s.sumG += p.g * p.count;
                s.sumB += p.b * p.count;
                s.totalCount += p.count;
            }

            for (let i = 0; i < centers.length; i++) {
                const s = nextSums[i];
                if (s.totalCount > 0) {
                    centers[i].r = Math.round(s.sumR / s.totalCount);
                    centers[i].g = Math.round(s.sumG / s.totalCount);
                    centers[i].b = Math.round(s.sumB / s.totalCount);
                }
            }
        }

        return centers;
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Image loading error.'));
            img.src = url;
        });
    }

    function getGameCanvas() {
        const all = [...document.querySelectorAll('canvas')];
        if (!all.length) return null;
        const largest = all.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
        if (largest.width >= 400) return largest;
        return null;
    }

    function clampInt(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function buildFillBatchFrame(strokeId, hexColor, rects) {
        if (!Number.isInteger(strokeId) || strokeId < 0) return null;
        if (!HEX_COLOR_RE.test(hexColor)) return null;
        if (!Array.isArray(rects) || rects.length === 0) return null;

        const v = [8, strokeId, [hexColor.toUpperCase(), 10]];

        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            if (
                !rect ||
                !Number.isInteger(rect.x) ||
                !Number.isInteger(rect.y) ||
                !Number.isInteger(rect.w) ||
                !Number.isInteger(rect.h) ||
                (rect.parentIndex !== undefined && !Number.isInteger(rect.parentIndex)) ||
                rect.w < 1 ||
                rect.h < 1
            ) {
                return null;
            }
            // For backward compatibility with old-style rects, calculate parentIndex
            const parentIndex = (rect.parentIndex !== undefined) ? rect.parentIndex : (i === 0 ? 0 : (i - 1) * 5);
            v.push(rect.x, rect.y, rect.w, rect.h, parentIndex);
        }

        if ((v.length - 3) % 5 !== 0) return null;

        const packet = {
            t: CFG.currentTurnId,
            d: 1,
            v
        };
        const frame = `${wsPrefix}${JSON.stringify(packet)}]`;
        if (!frame.startsWith('42[')) return null;

        return { frame };
    }

    // --- Optimized Fill Geometry Engine (Numeric Keys + DFS + Area-Maximizing Rects) ---

    function findMaximalRectangleOpt(startX, startY, pixelSet, gridWidth, height) {
        const startKey = startY * gridWidth + startX;
        if (pixelSet[startKey] !== 1) return null;

        // Strategy 1: expand RIGHT first, then DOWN (allowing width to narrow for max area)
        let w1 = 0;
        while (startX + w1 < gridWidth && pixelSet[startY * gridWidth + startX + w1] === 1) w1++;
        let bestW1 = w1, bestH1 = 1, bestArea1 = w1;
        let currW = w1;
        for (let dy = 1; startY + dy < height; dy++) {
            const rowBase = (startY + dy) * gridWidth + startX;
            let rowW = 0;
            while (rowW < currW && pixelSet[rowBase + rowW] === 1) rowW++;
            if (rowW < 1) break;
            currW = rowW;
            const area = currW * (dy + 1);
            if (area > bestArea1) { bestArea1 = area; bestW1 = currW; bestH1 = dy + 1; }
        }

        // Strategy 2: expand DOWN first, then RIGHT (allowing height to narrow for max area)
        let h2 = 0;
        while (startY + h2 < height && pixelSet[(startY + h2) * gridWidth + startX] === 1) h2++;
        let bestW2 = 1, bestH2 = h2, bestArea2 = h2;
        let currH = h2;
        for (let dx = 1; startX + dx < gridWidth; dx++) {
            let colH = 0;
            while (colH < currH && pixelSet[(startY + colH) * gridWidth + startX + dx] === 1) colH++;
            if (colH < 1) break;
            currH = colH;
            const area = (dx + 1) * currH;
            if (area > bestArea2) { bestArea2 = area; bestW2 = dx + 1; bestH2 = currH; }
        }

        // Pick the strategy with larger area
        const bestW = bestArea1 >= bestArea2 ? bestW1 : bestW2;
        const bestH = bestArea1 >= bestArea2 ? bestH1 : bestH2;

        // Remove consumed pixels from set
        let removed = 0;
        for (let dy = 0; dy < bestH; dy++) {
            const rowBase = (startY + dy) * gridWidth + startX;
            for (let dx = 0; dx < bestW; dx++) {
                if (pixelSet[rowBase + dx] === 1) {
                    pixelSet[rowBase + dx] = 0;
                    removed++;
                }
            }
        }

        return { x: startX, y: startY, w: bestW, h: bestH, removed };
    }

    function buildRectangleTreeDFS(pixelSet, initialPixelCount, gridWidth, height) {
        const rects = [];
        const stack = []; // DFS stack
        let pixelCount = initialPixelCount;
        let lastSearchIdx = 0;

        while (pixelCount > 0) {
            // Find next active pixel index
            while (lastSearchIdx < pixelSet.length && pixelSet[lastSearchIdx] !== 1) {
                lastSearchIdx++;
            }
            if (lastSearchIdx >= pixelSet.length) break;

            const startX = lastSearchIdx % gridWidth;
            const startY = Math.floor(lastSearchIdx / gridWidth);

            const rect = findMaximalRectangleOpt(startX, startY, pixelSet, gridWidth, height);
            if (!rect) break;
            pixelCount -= rect.removed;

            rect.parentRef = null; // Root of a new island
            rects.push(rect);
            stack.push(rect);

            // DFS traversal
            while (stack.length > 0) {
                const currentRect = stack.pop();
                const candidates = [];

                // Top border: y - 1
                if (currentRect.y > 0) {
                    const rowBase = (currentRect.y - 1) * gridWidth;
                    for (let px = currentRect.x; px < currentRect.x + currentRect.w; px++) {
                        if (pixelSet[rowBase + px] === 1) {
                            candidates.push(px, currentRect.y - 1);
                        }
                    }
                }

                // Bottom border: y + h
                if (currentRect.y + currentRect.h < height) {
                    const rowBase = (currentRect.y + currentRect.h) * gridWidth;
                    for (let px = currentRect.x; px < currentRect.x + currentRect.w; px++) {
                        if (pixelSet[rowBase + px] === 1) {
                            candidates.push(px, currentRect.y + currentRect.h);
                        }
                    }
                }

                // Left border: x - 1
                if (currentRect.x > 0) {
                    const checkX = currentRect.x - 1;
                    for (let py = currentRect.y; py < currentRect.y + currentRect.h; py++) {
                        if (pixelSet[py * gridWidth + checkX] === 1) {
                            candidates.push(checkX, py);
                        }
                    }
                }

                // Right border: x + w
                if (currentRect.x + currentRect.w < gridWidth) {
                    const checkX = currentRect.x + currentRect.w;
                    for (let py = currentRect.y; py < currentRect.y + currentRect.h; py++) {
                        if (pixelSet[py * gridWidth + checkX] === 1) {
                            candidates.push(checkX, py);
                        }
                    }
                }

                // Process candidates (stored as flat x,y pairs)
                for (let ci = 0; ci < candidates.length; ci += 2) {
                    const cx = candidates[ci];
                    const cy = candidates[ci + 1];
                    if (pixelSet[cy * gridWidth + cx] !== 1) continue; // Already consumed

                    const newRect = findMaximalRectangleOpt(cx, cy, pixelSet, gridWidth, height);
                    if (!newRect) continue;
                    pixelCount -= newRect.removed;

                    newRect.parentRef = currentRect;
                    rects.push(newRect);
                    stack.push(newRect);
                }
            }
        }

        return rects;
    }

    function countIslands(colorGrid, width, height) {
        const visited = new Uint8Array(width * height);
        let count = 0;
        const queue = new Int32Array(width * height);

        for (let y = 0; y < height; y++) {
            const rowBase = y * width;
            for (let x = 0; x < width; x++) {
                const key = rowBase + x;
                if (colorGrid[key] && !visited[key]) {
                    count++;
                    let head = 0;
                    let tail = 0;
                    queue[tail++] = key;
                    visited[key] = 1;

                    while (head < tail) {
                        const currKey = queue[head++];
                        const cx = currKey % width;
                        const cy = Math.floor(currKey / width);

                        const dirs = [0, 1, 0, -1, 1, 0, -1, 0];
                        for (let d = 0; d < 8; d += 2) {
                            const nx = cx + dirs[d];
                            const ny = cy + dirs[d + 1];
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                const nKey = ny * width + nx;
                                if (colorGrid[nKey] && !visited[nKey]) {
                                    visited[nKey] = 1;
                                    queue[tail++] = nKey;
                                }
                            }
                        }
                    }
                }
            }
        }
        return count;
    }

    function applyBridging(colorGrid, colorIndexGrid, width, height, hexColor, colorsToDraw, maxBridgeLength = 8) {
        const indexC = colorsToDraw.indexOf(hexColor);
        if (indexC === -1) return;

        // 1. Create bridgeable map from colorIndexGrid
        const isBridgeable = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const rowBase = y * width;
            for (let x = 0; x < width; x++) {
                const key = rowBase + x;
                const idx = colorIndexGrid[key];
                if (idx === indexC || idx > indexC) {
                    isBridgeable[key] = 1;
                }
            }
        }

        // 2. Find connected components of colorGrid
        const visited = new Uint8Array(width * height);
        const components = [];
        const pixelToComp = new Int32Array(width * height).fill(-1);
        const compQueue = new Int32Array(width * height);

        for (let y = 0; y < height; y++) {
            const rowBase = y * width;
            for (let x = 0; x < width; x++) {
                const startKey = rowBase + x;
                if (colorGrid[startKey] && !visited[startKey]) {
                    const compIdx = components.length;
                    const comp = [];
                    let head = 0;
                    let tail = 0;
                    compQueue[tail++] = startKey;
                    visited[startKey] = 1;

                    while (head < tail) {
                        const currKey = compQueue[head++];
                        comp.push(currKey);
                        pixelToComp[currKey] = compIdx;

                        const cx = currKey % width;
                        const cy = Math.floor(currKey / width);

                        const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                        for (const [dx, dy] of dirs) {
                            const nx = cx + dx;
                            const ny = cy + dy;
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                const nKey = ny * width + nx;
                                if (colorGrid[nKey] && !visited[nKey]) {
                                    visited[nKey] = 1;
                                    compQueue[tail++] = nKey;
                                }
                            }
                        }
                    }
                    components.push(comp);
                }
            }
        }

        if (components.length <= 1) return;

        // Parent pointer array for union-find on components
        const parent = Array(components.length).fill(0).map((_, i) => i);
        function find(i) {
            let root = i;
            while (parent[root] !== root) root = parent[root];
            let curr = i;
            while (curr !== root) {
                const next = parent[curr];
                parent[curr] = root;
                curr = next;
            }
            return root;
        }
        function union(i, j) {
            const rootI = find(i);
            const rootJ = find(j);
            if (rootI !== rootJ) {
                parent[rootI] = rootJ;
                return true;
            }
            return false;
        }

        // Multi-source BFS structures
        const bfsQueue = new Int32Array(width * height);
        const dist = new Int16Array(width * height).fill(-1);
        const origin = new Int32Array(width * height).fill(-1);
        const prev = new Int32Array(width * height).fill(-1);
        let tail = 0;

        // Initialize queue with all boundary pixels of all components
        for (let c = 0; c < components.length; c++) {
            for (const key of components[c]) {
                const px = key % width;
                const py = Math.floor(key / width);
                let isBoundary = false;
                const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                for (const [dx, dy] of dirs) {
                    const nx = px + dx;
                    const ny = py + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        if (!colorGrid[ny * width + nx]) {
                            isBoundary = true;
                            break;
                        }
                    } else {
                        isBoundary = true;
                        break;
                    }
                }
                if (isBoundary) {
                    bfsQueue[tail++] = key;
                    dist[key] = 0;
                    origin[key] = c;
                }
            }
        }

        let head = 0;
        while (head < tail) {
            const currKey = bfsQueue[head++];
            const currDist = dist[currKey];
            const currOrigin = origin[currKey];

            if (currDist >= maxBridgeLength) continue;

            const cx = currKey % width;
            const cy = Math.floor(currKey / width);

            const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
            for (const [dx, dy] of dirs) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const nKey = ny * width + nx;
                    if (isBridgeable[nKey]) {
                        if (dist[nKey] === -1) {
                            dist[nKey] = currDist + 1;
                            origin[nKey] = currOrigin;
                            prev[nKey] = currKey;
                            bfsQueue[tail++] = nKey;
                        } else {
                            const otherOrigin = origin[nKey];
                            if (find(currOrigin) !== find(otherOrigin)) {
                                if (currDist + dist[nKey] <= maxBridgeLength) {
                                    union(currOrigin, otherOrigin);

                                    // Backtrack from currKey
                                    let k1 = currKey;
                                    while (k1 !== -1 && dist[k1] > 0) {
                                        colorGrid[k1] = 1;
                                        k1 = prev[k1];
                                    }

                                    // Backtrack from nKey
                                    let k2 = nKey;
                                    while (k2 !== -1 && dist[k2] > 0) {
                                        colorGrid[k2] = 1;
                                        k2 = prev[k2];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    function splitIntoChunks(rects, hexColor, startStrokeId, maxRectsPerChunk) {
        const chunks = [];
        let currentChunkRects = [];
        let rectToLocalIndex = new Map();
        let currentStrokeId = startStrokeId;
        const chunkLimit = (Number.isInteger(maxRectsPerChunk) && maxRectsPerChunk > 0) ? maxRectsPerChunk : Infinity;

        // Base length of packet serialization:
        // wsPrefix + '{"t":' + turnId + ',"d":1,"v":[8,' + strokeId + ',["' + hexColor + '",10]]}' + ']'
        const baseLength = wsPrefix.length + 50 + hexColor.length;
        let currentEstimatedLength = baseLength;

        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];

            const currentOrig = rect.originalRect || rect;
            const parentOrig = currentOrig.parentRef;

            let parentIndex;
            let shouldForceSplit = false;

            if (parentOrig === null || parentOrig === undefined) {
                parentIndex = 0;
                if (currentChunkRects.length > 0) {
                    shouldForceSplit = true;
                }
            } else if (rectToLocalIndex.has(parentOrig)) {
                parentIndex = rectToLocalIndex.get(parentOrig) * 5;
            } else {
                parentIndex = 0;
                if (currentChunkRects.length > 0) {
                    shouldForceSplit = true;
                }
            }

            const scaledRect = {
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: rect.h,
                parentIndex: parentIndex
            };

            const rectStrLength =
                String(scaledRect.x).length +
                String(scaledRect.y).length +
                String(scaledRect.w).length +
                String(scaledRect.h).length +
                String(scaledRect.parentIndex).length + 5;

            if (shouldForceSplit ||
                currentChunkRects.length >= chunkLimit ||
                (currentEstimatedLength + rectStrLength > FAST_FILL_MAX_FRAME_CHARS)) {

                if (currentChunkRects.length > 0) {
                    const res = buildFillBatchFrame(currentStrokeId, hexColor, currentChunkRects);
                    const frame = res ? res.frame : null;
                    chunks.push({ frame, strokeId: currentStrokeId, rectCount: currentChunkRects.length, rects: [...currentChunkRects] });
                    currentStrokeId++;
                }

                scaledRect.parentIndex = 0;
                currentChunkRects = [scaledRect];
                rectToLocalIndex.clear();
                rectToLocalIndex.set(currentOrig, 0);
                currentEstimatedLength = baseLength +
                    String(scaledRect.x).length +
                    String(scaledRect.y).length +
                    String(scaledRect.w).length +
                    String(scaledRect.h).length +
                    String(0).length + 5;
                continue;
            }

            currentChunkRects.push(scaledRect);
            rectToLocalIndex.set(currentOrig, currentChunkRects.length - 1);
            currentEstimatedLength += rectStrLength;
        }

        if (currentChunkRects.length > 0) {
            const res = buildFillBatchFrame(currentStrokeId, hexColor, currentChunkRects);
            const frame = res ? res.frame : null;
            chunks.push({ frame, strokeId: currentStrokeId, rectCount: currentChunkRects.length, rects: [...currentChunkRects] });
        }

        return chunks;
    }

    // Grid-based version: optimized with numeric keys + DFS + area-maximizing rects
    function generateFillBatchesFromGrid(colorGrid, width, height, hexColor, startStrokeId, step, scaleX, scaleY, canvas, maxRectsPerChunk) {
        const t0 = performance.now();

        // colorGrid is already a flat Uint8Array, so just duplicate it
        const pixelSet = new Uint8Array(colorGrid);
        let pixelCount = 0;
        for (let i = 0; i < pixelSet.length; i++) {
            if (pixelSet[i] === 1) pixelCount++;
        }

        if (pixelCount === 0) return { frames: [], nextStrokeId: startStrokeId };

        const initialPixelCount = pixelCount;

        // Generate rectangles with parent tree (DFS, flat array keys, optimized rect finding)
        const rects = buildRectangleTreeDFS(pixelSet, pixelCount, width, height);
        if (rects.length === 0) return { frames: [], nextStrokeId: startStrokeId };

        const t1 = performance.now();
        debugLog(`[DrawBot] Optimization: ${pixelCount} px → ${rects.length} rects in ${(t1 - t0).toFixed(1)}ms`);

        // Map rects to canvas coordinates (preserve DFS order for parent chain)
        const canvasRects = [];
        for (const rect of rects) {
            const sx1 = Math.round(rect.x * step * scaleX);
            const sy1 = Math.round(rect.y * step * scaleY);
            const sx2 = Math.round((rect.x + rect.w) * step * scaleX);
            const sy2 = Math.round((rect.y + rect.h) * step * scaleY);

            const clampedRect = {
                x: Math.max(0, Math.min(sx1, canvas.width - 1)),
                y: Math.max(0, Math.min(sy1, canvas.height - 1)),
                w: Math.max(1, sx2 - sx1),
                h: Math.max(1, sy2 - sy1),
                originalRect: rect
            };

            if (clampedRect.x + clampedRect.w <= 0 ||
                clampedRect.y + clampedRect.h <= 0 ||
                clampedRect.x >= canvas.width ||
                clampedRect.y >= canvas.height) {
                continue;
            }

            canvasRects.push(clampedRect);
        }

        if (canvasRects.length === 0) return { frames: [], nextStrokeId: startStrokeId };

        const chunks = splitIntoChunks(canvasRects, hexColor, startStrokeId, maxRectsPerChunk);
        const frames = chunks.map(chunk => ({
            frame: chunk.frame,
            strokeId: chunk.strokeId,
            rectCount: chunk.rectCount,
            hexColor: hexColor,
            rects: chunk.rects
        }));

        const t2 = performance.now();
        debugLog(`[DrawBot] Batching: ${canvasRects.length} rects → ${chunks.length} packets in ${(t2 - t1).toFixed(1)}ms`);

        return {
            frames: frames,
            nextStrokeId: startStrokeId + chunks.length
        };
    }

    // --- Geometry Optimization ---
    function findMaxRectangles(grid, width, height, minW, minH) {
        const rects = [];
        const avail = new Uint8Array(grid); // copy flat grid

        for (let y = 0; y < height; y++) {
            const rowBase = y * width;
            for (let x = 0; x < width; x++) {
                if (!avail[rowBase + x]) continue;

                let maxW = 0;
                while (x + maxW < width && avail[rowBase + x + maxW]) maxW++;

                let bestW = maxW, bestH = 1, bestArea = maxW;
                let currW = maxW;

                for (let h = 2; y + h <= height; h++) {
                    const nextRowBase = (y + h - 1) * width;
                    let rowW = 0;
                    while (rowW < currW && x + rowW < width && avail[nextRowBase + x + rowW]) rowW++;
                    currW = rowW;
                    if (currW < minW) break;

                    let area = currW * h;
                    if (area > bestArea) {
                        bestArea = area;
                        bestW = currW;
                        bestH = h;
                    }
                }

                if (bestW >= minW && bestH >= minH) {
                    rects.push({ x, y, width: bestW, height: bestH });
                    for (let dy = 0; dy < bestH; dy++) {
                        const targetRowBase = (y + dy) * width;
                        for (let dx = 0; dx < bestW; dx++) {
                            avail[targetRowBase + x + dx] = 0;
                        }
                    }
                }
            }
        }
        return { rects, remainingGrid: avail };
    }

    function findPaths(avail, width, height) {
        const paths = [];
        for (let y = 0; y < height; y++) {
            const rowBase = y * width;
            for (let x = 0; x < width; x++) {
                const key = rowBase + x;
                if (!avail[key]) continue;

                const path = [];
                let cx = x, cy = y;
                path.push({ x: cx, y: cy });
                avail[cy * width + cx] = 0;

                let lastDx = 0, lastDy = 0;

                while (true) {
                    let nextDx = 0, nextDy = 0, found = false;

                    if (lastDx !== 0 || lastDy !== 0) {
                        let nx = cx + lastDx, ny = cy + lastDy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height && avail[ny * width + nx]) {
                            nextDx = lastDx; nextDy = lastDy; found = true;
                        }
                    }

                    if (!found) {
                        const dxs = [1, -1, 0, 0, 1, -1, 1, -1];
                        const dys = [0, 0, 1, -1, 1, 1, -1, -1];
                        for (let i = 0; i < 8; i++) {
                            let nx = cx + dxs[i], ny = cy + dys[i];
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height && avail[ny * width + nx]) {
                                nextDx = dxs[i]; nextDy = dys[i]; found = true;
                                break;
                            }
                        }
                    }

                    if (!found) break;

                    cx += nextDx; cy += nextDy;
                    path.push({ x: cx, y: cy });
                    avail[cy * width + cx] = 0;
                    lastDx = nextDx; lastDy = nextDy;
                }
                paths.push(path);
            }
        }
        return paths;
    }

    function simplifyPath(path) {
        if (path.length <= 2) return path;
        const simplified = [path[0]];
        for (let i = 1; i < path.length - 1; i++) {
            const prev = path[i - 1], curr = path[i], next = path[i + 1];
            const isCollinear = (curr.x - prev.x) * (next.y - curr.y) === (next.x - prev.x) * (curr.y - prev.y);
            if (!isCollinear) simplified.push(curr);
        }
        simplified.push(path[path.length - 1]);
        return simplified;
    }

    // --- Packet Sending Functions ---
    // Every send function resolves to true only if the frame actually left through the socket.
    async function safeSendWithRetry(frame) {
        if (!wsInstance || !frame || cancelFlag) return false;
        const attempts = 3;
        for (let i = 0; i < attempts; i++) {
            try {
                if (wsInstance.readyState !== 1) {
                    throw new Error(`WebSocket is not in OPEN state (readyState: ${wsInstance.readyState})`);
                }
                originalSend.call(wsInstance, frame);
                return true;
            } catch (e) {
                console.warn(`[DrawBot] Packet send failed (attempt ${i + 1}/${attempts}):`, e);
                if (i === attempts - 1 || cancelFlag) {
                    return false;
                }
                await sleep(150);
            }
        }
        return false;
    }

    function isSocketClosed() {
        return !wsInstance || wsInstance.readyState === 2 || wsInstance.readyState === 3;
    }

    async function sendRectPacket(strokeId, hexColor, thickness, x1, y1, x2, y2) {
        if (!wsInstance || cancelFlag) return false;
        const rectPacket = {
            t: CFG.currentTurnId,
            d: 1,
            v: [6, strokeId, [hexColor, thickness, 10], x1, y1, x2, y2]
        };
        const frame = `${wsPrefix}${JSON.stringify(rectPacket)}]`;
        debugLog('[DrawBot] Sent rectangle packet (Tool 6):', frame);
        const sent = await safeSendWithRetry(frame);
        await sleep(CFG.packetDelay);
        return sent;
    }

    async function sendFillPacket(strokeId, hexColor, width, height) {
        if (!wsInstance || cancelFlag) return false;
        const fillPacket = {
            t: CFG.currentTurnId,
            d: 1,
            v: [8, strokeId, [hexColor, 10], 0, 0, width, height, 0]
        };
        const frame = `${wsPrefix}${JSON.stringify(fillPacket)}]`;
        debugLog('[DrawBot] Sent background fill packet (Tool 8):', frame);
        const sent = await safeSendWithRetry(frame);
        await sleep(CFG.packetDelay);
        return sent;
    }

    async function sendFillBatchPacket(frame, rectCount, delayMs) {
        if (!wsInstance || !frame || cancelFlag) return false;
        const delay = (typeof delayMs === 'number' && delayMs >= 0) ? delayMs : CFG.packetDelay;
        debugLog(`[DrawBot] Sent Tool 8 packet (rects: ${rectCount}, length: ${frame.length}, delay: ${delay}ms)`);
        const sent = await safeSendWithRetry(frame);
        await sleep(delay);
        return sent;
    }

    async function sendStrokePackets(strokeId, hexColor, points, thickness) {
        if (!wsInstance || points.length === 0 || cancelFlag) return false;

        const start = points[0];
        const startPacket = {
            t: CFG.currentTurnId,
            d: 1,
            v: [1, strokeId, [hexColor, thickness, 10], start.x, start.y]
        };
        const startFrame = `${wsPrefix}${JSON.stringify(startPacket)}]`;
        debugLog('[DrawBot] Sent line start packet (Tool 1):', startFrame);
        const startSent = await safeSendWithRetry(startFrame);
        await sleep(CFG.packetDelay);
        if (!startSent) return false;

        if (points.length > 1 && !cancelFlag) {
            const vArray = [1, strokeId, [hexColor, thickness, 10], start.x, start.y];
            for (let i = 1; i < points.length; i++) {
                vArray.push(points[i].x - points[i - 1].x);
                vArray.push(points[i].y - points[i - 1].y);
            }
            const movePacket = {
                t: CFG.currentTurnId,
                d: 3,
                v: vArray
            };
            const moveFrame = `${wsPrefix}${JSON.stringify(movePacket)}]`;
            debugLog('[DrawBot] Sent line move packet (Tool 1):', moveFrame);
            const moveSent = await safeSendWithRetry(moveFrame);
            await sleep(CFG.packetDelay);
            return moveSent;
        }
        return true;
    }

    // --- Image Preprocessing & Analysis ---
    // Returns the image as a flat grid of color indices (-1 = transparent) plus the list of
    // distinct hex colors those indices point to. Every color in the list occurs in the grid.
    function processImage(img, step, colorsMode, denoiseLevel) {
        const w = Math.round(768 / step);
        const h = Math.round(448 / step);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = w;
        tempCanvas.height = h;
        const ctx = tempCanvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        if (layoutMode === 'stretch') {
            ctx.drawImage(img, 0, 0, w, h);
        } else if (layoutMode === 'center') {
            const imgRatio = img.width / img.height;
            const canvasRatio = 768 / 448;
            let dw, dh, dx, dy;
            if (imgRatio > canvasRatio) {
                dw = w;
                dh = w / imgRatio;
            } else {
                dh = h;
                dw = h * imgRatio;
            }
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
            ctx.drawImage(img, dx, dy, dw, dh);
        } else if (layoutMode === 'custom') {
            const cx = customX / step;
            const cy = customY / step;
            const cw = customW / step;
            const ch = customH / step;
            ctx.drawImage(img, cx, cy, cw, ch);
        }

        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Use 24-bit integers instead of hex string conversions inside 344k loop
        const colorCounts = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 150) {
                continue; // Skip transparent/margins
            }
            const rgbInt = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            colorCounts.set(rgbInt, (colorCounts.get(rgbInt) || 0) + 1);
        }

        let palette = [];
        if (colorsMode === 'gartic') {
            palette = GARTIC_PALETTE;
        } else if (colorsMode === 'infinite') {
            palette = Array.from(colorCounts.keys()).map(rgbInt => ({
                r: (rgbInt >> 16) & 255,
                g: (rgbInt >> 8) & 255,
                b: rgbInt & 255
            }));
        } else {
            const maxColors = parseInt(colorsMode, 10);
            const uniqueColors = Array.from(colorCounts.entries()).map(([rgbInt, count]) => ({
                r: (rgbInt >> 16) & 255,
                g: (rgbInt >> 8) & 255,
                b: rgbInt & 255,
                count
            }));
            palette = quantize(uniqueColors, maxColors);
        }

        // Cache hex strings for colors in the palette (typically <= 64, or unique count if infinite)
        const paletteHex = palette.map(c => rgbToHex(c.r, c.g, c.b));
        const whiteIdx = paletteHex.indexOf('#FFFFFF');

        // Int32: "No limit" mode can have far more than 32767 palette entries
        const pixelIndices = new Int32Array(w * h);
        for (let y = 0; y < h; y++) {
            const rowOffset = y * w;
            for (let x = 0; x < w; x++) {
                const idx = (rowOffset + x) * 4;
                const a = data[idx + 3];
                if (a < 150) {
                    pixelIndices[rowOffset + x] = -1; // -1 represents transparent
                } else {
                    let r = data[idx]; let g = data[idx + 1]; let b = data[idx + 2];
                    let closestIdx = 0;
                    let minDist = Infinity;
                    const p = { r, g, b };
                    for (let i = 0; i < palette.length; i++) {
                        const dist = getDistance(p, palette[i]);
                        if (dist < minDist) {
                            minDist = dist;
                            closestIdx = i;
                        }
                    }
                    pixelIndices[rowOffset + x] = closestIdx;
                }
            }
        }

        if (denoiseLevel > 0) {
            const tempIndices = new Int32Array(pixelIndices);
            const counts = new Map();
            for (let y = 0; y < h; y++) {
                const rowOffset = y * w;
                for (let x = 0; x < w; x++) {
                    const idx = rowOffset + x;
                    const colorIdx = pixelIndices[idx];
                    if (colorIdx === -1 || colorIdx === whiteIdx) continue;

                    let sameNeighbors = 0;
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            if (dx === 0 && dy === 0) continue;
                            const nx = x + dx;
                            const ny = y + dy;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                if (pixelIndices[ny * w + nx] === colorIdx) sameNeighbors++;
                            }
                        }
                    }

                    if (sameNeighbors < denoiseLevel) {
                        counts.clear();
                        let maxCount = 0;
                        let bestColorIdx = colorIdx;

                        for (let dx = -1; dx <= 1; dx++) {
                            for (let dy = -1; dy <= 1; dy++) {
                                if (dx === 0 && dy === 0) continue;
                                const nx = x + dx;
                                const ny = y + dy;
                                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                    const nIdx = pixelIndices[ny * w + nx];
                                    if (nIdx === -1) continue; // Skip transparent neighbors/canvas margins
                                    const c = (counts.get(nIdx) || 0) + 1;
                                    counts.set(nIdx, c);
                                    if (c > maxCount) {
                                        maxCount = c;
                                        bestColorIdx = nIdx;
                                    } else if (c === maxCount) {
                                        const c1 = palette[nIdx];
                                        const c2 = palette[bestColorIdx];
                                        const orig = palette[colorIdx];
                                        const d1 = getDistance(c1, orig);
                                        const d2 = getDistance(c2, orig);
                                        if (d1 < d2) {
                                            bestColorIdx = nIdx;
                                        }
                                    }
                                }
                            }
                        }
                        tempIndices[idx] = bestColorIdx;
                    }
                }
            }
            pixelIndices.set(tempIndices);
        }

        // Re-index to distinct colors actually present: quantization can produce palette
        // entries that round to the same hex, and many palette entries may stay unused
        const colors = [];
        const hexToColorIdx = new Map();
        const paletteToColorIdx = new Int32Array(palette.length).fill(-1);
        for (let i = 0; i < pixelIndices.length; i++) {
            const p = pixelIndices[i];
            if (p === -1) continue;
            let c = paletteToColorIdx[p];
            if (c === -1) {
                const hex = paletteHex[p];
                c = hexToColorIdx.get(hex);
                if (c === undefined) {
                    c = colors.length;
                    colors.push(hex);
                    hexToColorIdx.set(hex, c);
                }
                paletteToColorIdx[p] = c;
            }
            pixelIndices[i] = c;
        }

        return { indices: pixelIndices, colors, width: w, height: h };
    }

    // Preview and drawing need the same processed image; recomputing it is the slowest step
    let processedCache = null;
    function processImageCached(img, src, step, colorsMode, denoiseLevel) {
        const key = [step, colorsMode, denoiseLevel, layoutMode, customX, customY, customW, customH].join('|');
        if (processedCache && processedCache.src === src && processedCache.key === key) {
            return processedCache.result;
        }
        const result = processImage(img, step, colorsMode, denoiseLevel);
        processedCache = { src, key, result };
        return result;
    }

    // Most common color: drawn as one background fill instead of many rectangles
    function findBackgroundColorIdx(indices, colorCount) {
        const counts = new Int32Array(colorCount);
        for (let i = 0; i < indices.length; i++) {
            if (indices[i] >= 0) counts[indices[i]]++;
        }
        let best = -1;
        let bestCount = 0;
        for (let c = 0; c < colorCount; c++) {
            if (counts[c] > bestCount) {
                bestCount = counts[c];
                best = c;
            }
        }
        return best;
    }

    function buildColorMask(indices, colorIdx) {
        const mask = new Uint8Array(indices.length);
        for (let i = 0; i < indices.length; i++) {
            if (indices[i] === colorIdx) mask[i] = 1;
        }
        return mask;
    }

    // Standard Lines mode: rectangles first, then the leftover pixels as straight lines or paths
    function buildLineCommands(mask, width, height, step, scaleX, scaleY) {
        const toCanvasRect = (x, y, w, h) => ({
            kind: 'rect',
            x1: Math.round(x * step * scaleX),
            y1: Math.round(y * step * scaleY),
            x2: Math.round((x + w) * step * scaleX),
            y2: Math.round((y + h) * step * scaleY)
        });

        const commands = [];
        const { rects, remainingGrid } = findMaxRectangles(mask, width, height, 2, 2);
        for (const r of rects) {
            commands.push(toCanvasRect(r.x, r.y, r.width, r.height));
        }

        const paths = findPaths(remainingGrid, width, height);
        for (const path of paths) {
            const first = path[0];
            if (path.length === 1) {
                commands.push(toCanvasRect(first.x, first.y, 1, 1));
            } else if (path.every(p => p.y === first.y)) {
                const xs = path.map(p => p.x);
                const minX = Math.min(...xs);
                commands.push(toCanvasRect(minX, first.y, Math.max(...xs) - minX + 1, 1));
            } else if (path.every(p => p.x === first.x)) {
                const ys = path.map(p => p.y);
                const minY = Math.min(...ys);
                commands.push(toCanvasRect(first.x, minY, 1, Math.max(...ys) - minY + 1));
            } else {
                const points = simplifyPath(path.map(p => ({
                    x: Math.round((p.x * step + step / 2) * scaleX),
                    y: Math.round((p.y * step + step / 2) * scaleY)
                })));
                commands.push({ kind: 'path', points });
            }
        }
        return commands;
    }

    // Progress units of one line-mode command: a path is a start packet plus a move packet
    function lineCommandWeight(cmd) {
        return cmd.kind === 'path' && cmd.points.length > 1 ? 2 : 1;
    }

    // Everything the bot will send, computed once. The preview uses it for its numbers,
    // the drawing loop sends it as is. In fill mode the frames already carry their stroke IDs.
    function buildDrawPlan(processed, opts) {
        const { indices, colors, width, height } = processed;
        const { fillBg, drawMode, batchSize, useBridge, maxBridgeLength, step, canvas } = opts;
        const scaleX = canvas.width / 768;
        const scaleY = canvas.height / 448;
        let strokeId = opts.startStrokeId;

        const bgIdx = fillBg ? findBackgroundColorIdx(indices, colors.length) : -1;
        let background = null;
        if (bgIdx >= 0) {
            // Sent twice, the first fill packet is sometimes dropped by the game
            background = { hex: colors[bgIdx], strokeIds: [strokeId++, strokeId++] };
        }

        const order = [];
        for (let c = 0; c < colors.length; c++) {
            if (c !== bgIdx) order.push(c);
        }

        const steps = [];
        let rectCount = 0;
        let pathCount = 0;
        let packetCount = 0;
        let totalCommands = background ? background.strokeIds.length : 0;

        if (drawMode === 'fill') {
            // Colors with many islands go first so later colors can bridge across them
            const islands = new Map();
            for (const c of order) {
                islands.set(c, countIslands(buildColorMask(indices, c), width, height));
            }
            order.sort((a, b) => islands.get(b) - islands.get(a));

            const orderHex = order.map(c => colors[c]);
            const colorToOrder = new Int32Array(colors.length).fill(-1);
            order.forEach((c, i) => { colorToOrder[c] = i; });
            const colorIndexGrid = new Int32Array(indices.length);
            for (let i = 0; i < indices.length; i++) {
                colorIndexGrid[i] = indices[i] >= 0 ? colorToOrder[indices[i]] : -1;
            }

            for (const c of order) {
                const hex = colors[c];
                const mask = buildColorMask(indices, c);
                if (useBridge) {
                    applyBridging(mask, colorIndexGrid, width, height, hex, orderHex, maxBridgeLength);
                }
                const result = generateFillBatchesFromGrid(mask, width, height, hex, strokeId, step, scaleX, scaleY, canvas, batchSize);
                strokeId = result.nextStrokeId;
                if (result.frames.length === 0) continue;
                steps.push({ hex, frames: result.frames });
                packetCount += result.frames.length;
                rectCount += result.frames.reduce((acc, f) => acc + f.rectCount, 0);
            }
            totalCommands += packetCount;
        } else {
            for (const c of order) {
                const commands = buildLineCommands(buildColorMask(indices, c), width, height, step, scaleX, scaleY);
                if (commands.length === 0) continue;
                steps.push({ hex: colors[c], commands });
                for (const cmd of commands) {
                    if (cmd.kind === 'rect') rectCount++;
                    else pathCount++;
                    totalCommands += lineCommandWeight(cmd);
                }
            }
        }

        // Lines mode assigns stroke IDs while sending, starting here
        return { background, steps, rectCount, pathCount, packetCount, totalCommands, nextStrokeId: strokeId };
    }

    // --- Draw options from the panel ---
    const BATCH_SIZE_DEFAULT = 3000;
    const BATCH_SIZE_MAX = 9000;
    const PREVIEW_DEBOUNCE_MS = 300;

    function readDrawOptions() {
        const el = id => document.getElementById(id);
        const readInt = (id, fallback, min, max) => {
            const v = parseInt(el(id) ? el(id).value : '', 10);
            return isNaN(v) ? fallback : clampInt(v, min, max);
        };
        return {
            step: readInt('db-scale', 4, 1, 15),
            colorsMode: el('db-colors-mode') ? el('db-colors-mode').value : '8',
            denoiseLevel: readInt('db-denoise-level', 0, 0, 3),
            fillBg: el('db-fill-bg') ? el('db-fill-bg').checked : false,
            drawMode: el('db-draw-mode') ? el('db-draw-mode').value : 'fill',
            batchSize: readInt('db-batch-size', BATCH_SIZE_DEFAULT, 1, BATCH_SIZE_MAX),
            useBridge: el('db-use-bridge') ? el('db-use-bridge').checked : false,
            maxBridgeLength: readInt('db-bridge-len', 50, 1, 150),
            packetDelay: readInt('db-delay', 127, 0, 1000),
            fillPPS: readInt('db-fill-pps', 8, 1, 30)
        };
    }

    function fillIntervalFor(pps) {
        return Math.max(125, Math.ceil(1000 / pps)) + 2;
    }

    // Each call bumps the generation, so a slow older preview cannot overwrite a newer one
    let previewGeneration = 0;
    async function processAndPreviewImage(src) {
        if (!src) return;
        const generation = ++previewGeneration;
        const infoEl = document.getElementById('db-preview-info');
        infoEl.textContent = 'Processing...';

        try {
            const img = await loadImage(src);
            if (generation !== previewGeneration) return;
            draftImg = img;
            const opts = readDrawOptions();
            CFG.maxBridgeLength = opts.maxBridgeLength;

            const processed = processImageCached(img, src, opts.step, opts.colorsMode, opts.denoiseLevel);
            const plan = buildDrawPlan(processed, Object.assign({}, opts, {
                canvas: getGameCanvas() || { width: 768, height: 448 },
                startStrokeId: 1
            }));

            // Render Preview Canvas
            const pCanvas = document.getElementById('db-preview-canvas');
            pCanvas.width = processed.width;
            pCanvas.height = processed.height;
            const pCtx = pCanvas.getContext('2d');
            const pImgData = pCtx.createImageData(processed.width, processed.height);
            const pData = pImgData.data;
            const rgbColors = processed.colors.map(hexToRgb);

            for (let i = 0; i < processed.indices.length; i++) {
                const c = processed.indices[i];
                if (c === -1) continue; // createImageData starts fully transparent
                const rgb = rgbColors[c];
                const idx = i * 4;
                pData[idx] = rgb.r;
                pData[idx + 1] = rgb.g;
                pData[idx + 2] = rgb.b;
                pData[idx + 3] = 255;
            }
            pCtx.putImageData(pImgData, 0, 0);
            document.getElementById('db-preview-container').style.display = 'flex';

            if (opts.drawMode === 'fill') {
                const fillInterval = fillIntervalFor(opts.fillPPS);
                const estSec = Math.round((plan.packetCount * fillInterval) / 1000) + (plan.background ? 1 : 0);
                infoEl.innerHTML = `Rects: <b>${plan.rectCount}</b> | Packets: <b>${plan.packetCount}</b><br>Speed: <b>${opts.fillPPS} pkt/s</b> (${fillInterval}ms) | ~<b>${estSec}s</b>`;
            } else {
                const estSec = Math.round((plan.totalCommands * opts.packetDelay) / 1000);
                infoEl.innerHTML = `Rects: <b>${plan.rectCount}</b> | Lines: <b>${plan.pathCount}</b><br>Draw time: <b>~${estSec}s</b>`;
            }
            isApplied = true;
        } catch (e) {
            if (generation !== previewGeneration) return;
            console.error('[DrawBot] Preview error:', e);
            infoEl.textContent = 'Loading/preview error';
            isApplied = false;
        }
    }

    async function checkPause() {
        while (isPaused && !cancelFlag) {
            await sleep(100);
        }
    }

    function setDrawingControls(drawing) {
        const startBtn = document.getElementById('db-start');
        if (startBtn) startBtn.style.display = drawing ? 'none' : 'block';
        const pauseBtn = document.getElementById('db-pause');
        if (pauseBtn) {
            pauseBtn.style.display = drawing ? 'block' : 'none';
            pauseBtn.textContent = '⏸ Pause';
            pauseBtn.style.background = '#d97706';
        }
        const cancelBtn = document.getElementById('db-cancel');
        if (cancelBtn) cancelBtn.style.display = drawing ? 'block' : 'none';
        const progressWrapper = document.getElementById('db-progress-wrapper');
        if (progressWrapper) progressWrapper.style.display = drawing ? 'block' : 'none';
    }

    function resetDrawUI() {
        isDrawing = false;
        try {
            setDrawingControls(false);
        } catch (e) {
            console.error('[DrawBot] Error during UI reset:', e);
        }
    }

    function updateStatus(msg, color = '#9ca3af') {
        const el = document.getElementById('db-status');
        if (el) {
            el.textContent = msg;
            el.style.color = color;
        }
    }

    function setProgress(pct, timeText) {
        const bar = document.getElementById('db-progress-bar');
        if (bar) bar.style.width = `${pct}%`;
        const percent = document.getElementById('db-progress-percent');
        if (percent) percent.textContent = `${pct}%`;
        const time = document.getElementById('db-progress-time');
        if (time) time.textContent = timeText;
    }

    // Local echo of what was sent, so the user sees the drawing appear
    function renderLocally(canvas, draw) {
        try {
            draw(canvas.getContext('2d'));
        } catch (e) {
            console.error('[DrawBot] Error rendering on canvas:', e);
        }
    }

    function strokeLocally(ctx, hex, thickness, points) {
        ctx.strokeStyle = hex;
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
    }

    // --- Drawing Loop ---
    async function runDraw() {
        if (!wsInstance) {
            alert('WebSocket not found! Try making one manual brush stroke on the canvas to initialize the socket.');
            return;
        }
        if (isDrawing) return;

        const canvas = getGameCanvas();
        if (!canvas) {
            alert('Enter the Gartic Phone drawing mode first!');
            return;
        }

        const drawTurnId = CFG.currentTurnId;
        let strokeId = strokeIdCounter;

        try {
            const opts = readDrawOptions();
            CFG.packetDelay = opts.packetDelay;
            CFG.fillPPS = opts.fillPPS;
            CFG.useBridge = opts.useBridge;
            CFG.maxBridgeLength = opts.maxBridgeLength;
            const fillInterval = fillIntervalFor(opts.fillPPS);
            const thickness = opts.step * 4 - 2;

            isDrawing = true;
            cancelFlag = false;
            isPaused = false;
            const drawStartTime = performance.now();

            setDrawingControls(true);
            setProgress(0, 'Remaining: ~0s');

            updateStatus('Loading image...', '#fbbf24');

            let img;
            try {
                img = await loadImage(currentImageSrc);
            } catch (e) {
                updateStatus('❌ Loading error', '#ef4444');
                return;
            }

            if (!isApplied) {
                updateStatus('Applying & Rendering Preview...', '#fbbf24');
                await processAndPreviewImage(currentImageSrc);
                if (!isApplied) {
                    updateStatus('❌ Preview render failed', '#ef4444');
                    return;
                }
                // Small delay to let user see preview and est draw time before drawing begins
                await sleep(1500);
            }

            updateStatus('Processing...', '#fbbf24');
            const processed = processImageCached(img, currentImageSrc, opts.step, opts.colorsMode, opts.denoiseLevel);
            const plan = buildDrawPlan(processed, Object.assign({}, opts, { canvas, startStrokeId: strokeId }));
            strokeId = plan.nextStrokeId;

            const totalCommands = plan.totalCommands || 1;
            const currentDelay = (opts.drawMode === 'fill') ? fillInterval : CFG.packetDelay;
            let commandsSent = 0;
            let packetsSent = 0;
            let packetsFailed = 0;
            let abortReason = '';

            function updateProgress() {
                const pct = Math.min(100, Math.round((commandsSent / totalCommands) * 100));
                const estLeft = Math.max(0, Math.round(((totalCommands - commandsSent) * currentDelay) / 1000));
                setProgress(pct, `Remaining: ~${estLeft}s`);
            }

            // Counts the outcome of one send; stops the run once the socket is gone,
            // since every further packet would fail too
            function trackSend(sent) {
                if (sent) {
                    packetsSent++;
                    return;
                }
                if (cancelFlag) return;
                packetsFailed++;
                if (isSocketClosed()) {
                    abortReason = 'Connection to the game was lost';
                    cancelFlag = true;
                }
            }

            // 1. Fill Background
            if (plan.background) {
                const { hex, strokeIds } = plan.background;
                updateStatus('Filling background...', hex);
                for (const id of strokeIds) {
                    await sleep(150);
                    trackSend(await sendFillPacket(id, hex, canvas.width, canvas.height));
                }
                if (packetsSent > 0) {
                    renderLocally(canvas, ctx => {
                        ctx.fillStyle = hex;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                    });
                }
                commandsSent += strokeIds.length;
                updateProgress();
            }

            // 2. Colors
            let lastPacketTime = performance.now() - fillInterval;
            for (let i = 0; i < plan.steps.length; i++) {
                if (cancelFlag) break;
                const { hex, frames, commands } = plan.steps[i];

                // Small delay before switching to new color to prevent packet spam
                if (i > 0) {
                    await sleep(125);
                    if (cancelFlag) break;
                }

                const colorLabel = `Color ${i + 1}/${plan.steps.length} (${hex})`;
                updateStatus(colorLabel, hex);

                if (opts.drawMode === 'fill') {
                    // --- Fast Fill Mode (Tool 8) ---
                    const fillSendStart = performance.now();
                    let fillSendCount = 0;
                    for (const frameObj of frames) {
                        await checkPause();
                        if (cancelFlag) break;

                        const sleepTime = Math.max(0, fillInterval - (performance.now() - lastPacketTime));
                        const sent = await sendFillBatchPacket(frameObj.frame, frameObj.rectCount, sleepTime);
                        lastPacketTime = performance.now();
                        trackSend(sent);

                        if (sent) {
                            renderLocally(canvas, ctx => {
                                ctx.fillStyle = hex;
                                for (const r of frameObj.rects) {
                                    ctx.fillRect(r.x, r.y, r.w, r.h);
                                }
                            });
                        }

                        commandsSent++;
                        fillSendCount++;

                        // Show real-time send speed
                        const elapsed = (performance.now() - fillSendStart) / 1000;
                        const realPPS = elapsed > 0 ? (fillSendCount / elapsed).toFixed(1) : '—';
                        updateStatus(`${colorLabel} — ${realPPS} pkt/s`, hex);
                        updateProgress();
                    }
                } else {
                    // --- Standard Mode (Lines and Squares) ---
                    for (const cmd of commands) {
                        await checkPause();
                        if (cancelFlag) break;

                        if (cmd.kind === 'rect') {
                            const sent = await sendRectPacket(strokeId++, hex, thickness, cmd.x1, cmd.y1, cmd.x2, cmd.y2);
                            trackSend(sent);
                            if (sent) {
                                renderLocally(canvas, ctx => strokeLocally(ctx, hex, thickness, [
                                    { x: cmd.x1, y: cmd.y1 },
                                    { x: cmd.x2, y: cmd.y2 }
                                ]));
                            }
                        } else {
                            const sent = await sendStrokePackets(strokeId++, hex, cmd.points, thickness);
                            trackSend(sent);
                            if (sent) {
                                renderLocally(canvas, ctx => strokeLocally(ctx, hex, thickness, cmd.points));
                            }
                        }

                        commandsSent += lineCommandWeight(cmd);
                        updateProgress();
                    }
                }
            }

            const elapsedSec = ((performance.now() - drawStartTime) / 1000).toFixed(1);
            const attempted = packetsSent + packetsFailed;
            if (abortReason) {
                updateStatus(`❌ ${abortReason} (${packetsSent} packets sent)`, '#ef4444');
            } else if (cancelFlag) {
                updateStatus(`⏹ Cancelled (${elapsedSec}s elapsed)`, '#ef4444');
            } else if (attempted === 0) {
                updateStatus('Nothing to draw: the image has no visible pixels.', '#fbbf24');
            } else if (packetsSent === 0) {
                updateStatus('❌ No packets could be sent. Check the connection and try again.', '#ef4444');
            } else {
                setProgress(100, `Done in ${elapsedSec}s!`);
                if (packetsFailed > 0) {
                    updateStatus(`⚠ Finished in ${elapsedSec}s, but ${packetsFailed} of ${attempted} packets failed to send. Some parts may be missing.`, '#fbbf24');
                } else {
                    updateStatus(`✅ Drawing completed in ${elapsedSec}s! (When you click "Done" the art will temporarily disappear, but it is fully saved and will be visible at the end)`, '#10b981');
                }
            }
        } catch (err) {
            console.error('[DrawBot] Critical error during drawing:', err);
            updateStatus('❌ Error during drawing', '#ef4444');
        } finally {
            // If the round changed mid-run, applyTurnId() already started a fresh sequence
            if (CFG.currentTurnId === drawTurnId) {
                strokeIdCounter = Math.max(strokeIdCounter, strokeId);
            }
            resetDrawUI();
        }
    }

    // --- UI Settings Persistence ---
    function saveSettings() {
        try {
            const settings = {
                scale: document.getElementById('db-scale')?.value || '4',
                colorsMode: document.getElementById('db-colors-mode')?.value || '8',
                drawMode: document.getElementById('db-draw-mode')?.value || 'fill',
                batchSize: document.getElementById('db-batch-size')?.value || String(BATCH_SIZE_DEFAULT),
                delay: document.getElementById('db-delay')?.value || '127',
                fillPPS: document.getElementById('db-fill-pps')?.value || '8',
                denoise: document.getElementById('db-denoise-level')?.value || '0',
                fillBg: document.getElementById('db-fill-bg')?.checked ?? false,
                useBridge: document.getElementById('db-use-bridge')?.checked ?? true,
                bridgeLen: document.getElementById('db-bridge-len')?.value || '50',
                layoutMode: layoutMode,
                customX: customX,
                customY: customY,
                customW: customW,
                customH: customH
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn('[DrawBot] Failed to save settings:', e);
        }
    }
    function loadSettings() {
        try {
            const data = localStorage.getItem(SETTINGS_KEY);
            if (!data) return null;
            return JSON.parse(data);
        } catch (e) {
            console.warn('[DrawBot] Failed to load settings:', e);
            return null;
        }
    }

    // Applies a saved value only if the control can take it, so settings saved by older
    // versions (missing keys, removed options, out-of-range numbers) keep the defaults
    function applySavedValue(id, value) {
        const el = document.getElementById(id);
        if (!el || value === undefined || value === null) return;
        if (el.type === 'checkbox') {
            if (typeof value === 'boolean') el.checked = value;
        } else if (el.tagName === 'SELECT') {
            if (Array.from(el.options).some(o => o.value === String(value))) el.value = String(value);
        } else if (el.type === 'number') {
            const n = Number(value);
            const min = el.min !== '' ? Number(el.min) : -Infinity;
            const max = el.max !== '' ? Number(el.max) : Infinity;
            if (Number.isFinite(n) && n >= min && n <= max) el.value = String(n);
        }
    }

    // --- Build UI ---
    function buildUI() {
        // Remove duplicates before check
        const existingPanels = document.querySelectorAll('#db-panel');
        if (existingPanels.length > 0) {
            for (let i = 1; i < existingPanels.length; i++) {
                console.log('[DrawBot] Bot panel duplicate removed');
                existingPanels[i].remove();
            }
            return;
        }
        if (document.getElementById('db-panel') || !document.head) return;

        // Inject Styles
        const style = document.createElement('style');
        style.innerHTML = `
            @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap');
            #db-panel {
                position: fixed; top: 20px; left: 20px; z-index: 2147483647;
                width: 280px; background: rgba(15, 23, 42, 0.9);
                backdrop-filter: blur(12px) saturate(180%);
                -webkit-backdrop-filter: blur(12px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 16px; font-family: 'Outfit', 'Inter', sans-serif;
                padding: 16px; color: #f1f5f9;
                box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5), 0 10px 10px -5px rgba(0,0,0,0.4);
                transition: box-shadow 0.3s, border-color 0.3s;
                user-select: none;
                cursor: move;
            }
            #db-panel.db-drop-active {
                border-color: #a78bfa;
                box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.6), 0 20px 25px -5px rgba(0,0,0,0.5);
            }
            #db-panel:hover {
                border-color: rgba(255, 255, 255, 0.18);
                box-shadow: 0 25px 30px -5px rgba(0,0,0,0.6), 0 15px 15px -5px rgba(0,0,0,0.5);
            }
            .pulse-dot {
                display: inline-block; width: 8px; height: 8px;
                background-color: #a78bfa; border-radius: 50%;
                box-shadow: 0 0 0 0 rgba(167, 139, 250, 0.7);
                animation: db-pulse 1.6s infinite cubic-bezier(0.66, 0, 0, 1);
            }
            @keyframes db-pulse {
                to { box-shadow: 0 0 0 8px rgba(167, 139, 250, 0); }
            }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'db-panel';
        panel.innerHTML = `
            <div id="db-header" style="cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px; margin-bottom: 12px;">
                <div style="font-weight: 800; color: #a78bfa; font-size: 14px; display: flex; align-items: center; gap: 6px;">
                    <span class="pulse-dot"></span>
                    DrawBot 1.2
                </div>
                <button id="db-minimize-btn" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 12px; transition: color 0.2s;">➖</button>
            </div>

            <div id="db-content">
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                        <input id="db-url" type="text" placeholder="Image URL, Ctrl+V or drop" style="flex: 1; padding: 8px; background: #1e293b; border: 1px solid #334155; color: white; border-radius: 8px; font-size: 12px; outline: none; transition: border-color 0.2s;">
                        <button id="db-file-btn" style="background: #334155; border: 1px solid #475569; color: white; padding: 8px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; transition: background 0.2s;">📁</button>
                    </div>
                    <input id="db-file" type="file" accept="image/*" style="display: none;">
                </div>

                <div id="db-preview-container" style="display: none; flex-direction: column; align-items: center; background: #0b0f19; border-radius: 10px; padding: 8px; margin-bottom: 12px; border: 1px solid #1e293b;">
                    <canvas id="db-preview-canvas" style="width: 100%; max-height: 140px; border-radius: 6px; object-fit: contain; image-rendering: pixelated; image-rendering: -moz-crisp-edges; image-rendering: crisp-edges;"></canvas>
                    <div id="db-preview-info" style="font-size: 10px; color: #94a3b8; margin-top: 6px; text-align: center; line-height: 1.4;"></div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <div style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Scale:</label>
                        <select id="db-scale" style="width: 100%; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; cursor: pointer;">
                            <option value="1">1x (HD)</option>
                            <option value="2">2x (Detailed)</option>
                            <option value="3">3x (Recommended)</option>
                            <option value="4" selected>4x (Sketch)</option>
                            <option value="5">5x (Pixel Art)</option>
                            <option value="6">6x (Large)</option>
                            <option value="7">7x (Bold)</option>
                            <option value="8">8x (Mosaic)</option>
                            <option value="9">9x (Very Large)</option>
                            <option value="10">10x (Max Speed)</option>
                            <option value="11">11x</option>
                            <option value="12">12x</option>
                            <option value="13">13x</option>
                            <option value="14">14x</option>
                            <option value="15">15x</option>
                        </select>
                    </div>
                    <div style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Colors:</label>
                        <select id="db-colors-mode" style="width: 100%; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; cursor: pointer;">
                                <option value="gartic">Game palette (18)</option>
                                <option value="8" selected>True Color (8)</option>
                            <option value="16">True Color (16)</option>
                            <option value="24">True Color (24)</option>
                            <option value="32">True Color (32)</option>
                            <option value="48">True Color (48)</option>
                            <option value="64">True Color (64)</option>
                            <option value="128">True Color (128)</option>
                            <option value="256">True Color (256)</option>
                            <option value="infinite">No limit</option>
                        </select>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <div style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Mode:</label>
                        <select id="db-draw-mode" style="width: 100%; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; cursor: pointer;">
                            <option value="fill" selected>Fast Fill</option>
                            <option value="lines">Standard Lines</option>
                        </select>
                    </div>
                    <div id="db-batch-wrapper" style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Rects per packet:</label>
                        <input type="number" id="db-batch-size" min="1" max="9000" value="3000" style="width: 100%; box-sizing: border-box; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; text-align: center; font-weight: 600;">
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <div style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Layout:</label>
                        <select id="db-layout-mode" style="width: 100%; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; cursor: pointer;">
                            <option value="stretch" selected>Stretch</option>
                            <option value="center">Center</option>
                            <option value="custom">Custom Scale</option>
                        </select>
                    </div>
                    <div style="flex: 1; font-size: 11px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <label for="db-turn-id" style="color: #94a3b8;">Round:</label>
                            <label title="Detect the round from game traffic. Editing the number switches to manual." style="display: flex; align-items: center; gap: 4px; cursor: pointer; color: #94a3b8; font-size: 10px;">
                                <input type="checkbox" id="db-turn-auto" checked style="accent-color: #a78bfa; margin: 0;"> Auto
                            </label>
                        </div>
                        <input type="number" id="db-turn-id" min="1" step="1" value="1" title="Current round, counted from 1 as in the game" style="width: 100%; box-sizing: border-box; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; text-align: center; font-weight: 600;">
                    </div>
                </div>

                <div id="db-custom-sliders" style="display: none; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 8px; margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 10px;">
                        <span style="color: #94a3b8;">Width:</span>
                        <input type="range" id="db-custom-w" min="10" max="768" value="384" style="width: 120px; accent-color: #a78bfa;">
                        <span id="db-val-w" style="color: #a78bfa; font-weight: bold; width: 30px; text-align: right;">384</span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 10px;">
                        <span style="color: #94a3b8;">Height:</span>
                        <input type="range" id="db-custom-h" min="10" max="448" value="224" style="width: 120px; accent-color: #a78bfa;">
                        <span id="db-val-h" style="color: #a78bfa; font-weight: bold; width: 30px; text-align: right;">224</span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 10px;">
                        <span style="color: #94a3b8;">X Pos:</span>
                        <input type="range" id="db-custom-x" min="0" max="768" value="0" style="width: 120px; accent-color: #a78bfa;">
                        <span id="db-val-x" style="color: #a78bfa; font-weight: bold; width: 30px; text-align: right;">0</span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 10px;">
                        <span style="color: #94a3b8;">Y Pos:</span>
                        <input type="range" id="db-custom-y" min="0" max="448" value="0" style="width: 120px; accent-color: #a78bfa;">
                        <span id="db-val-y" style="color: #a78bfa; font-weight: bold; width: 30px; text-align: right;">0</span>
                    </div>
                    <button id="db-custom-apply" style="width: 100%; padding: 6px; background: #8b5cf6; border: none; color: white; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Apply & Render Preview</button>
                </div>

                <div id="db-delay-wrapper" style="margin-bottom: 10px; font-size: 11px; display: flex; align-items: center; justify-content: space-between;">
                    <span style="color: #94a3b8;">Packet delay (ms):</span>
                    <input type="number" id="db-delay" min="0" max="1000" value="127" style="width: 70px; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 8px; font-size: 11px; outline: none; text-align: center; font-weight: 600;">
                </div>

                <div id="db-fill-pps-wrapper" style="margin-bottom: 10px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; background: rgba(167, 139, 250, 0.06); border: 1px solid rgba(167, 139, 250, 0.15); border-radius: 8px; padding: 8px;">
                    <span style="color: #c4b5fd; font-weight: 600;">⚡ Packets/s (fill):</span>
                    <input type="number" id="db-fill-pps" min="1" max="30" value="8" style="width: 60px; padding: 6px; background: #1e293b; color: #c4b5fd; border: 1px solid #7c3aed; border-radius: 8px; font-size: 11px; outline: none; text-align: center; font-weight: 800;">
                </div>

                <div id="db-bridge-len-wrapper" style="margin-bottom: 10px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; background: rgba(167, 139, 250, 0.06); border: 1px solid rgba(167, 139, 250, 0.15); border-radius: 8px; padding: 8px;">
                    <span style="color: #c4b5fd; font-weight: 600;">🌉 Bridge length (px):</span>
                    <input type="number" id="db-bridge-len" min="1" max="150" value="50" style="width: 60px; padding: 6px; background: #1e293b; color: #c4b5fd; border: 1px solid #7c3aed; border-radius: 8px; font-size: 11px; outline: none; text-align: center; font-weight: 800;">
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <div style="flex: 1; font-size: 11px;">
                        <label style="display: block; margin-bottom: 4px; color: #94a3b8;">Denoise filter:</label>
                        <select id="db-denoise-level" style="width: 100%; padding: 6px; background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; font-size: 11px; outline: none; cursor: pointer;">
                            <option value="0" selected>Off</option>
                            <option value="1">Weak (1px)</option>
                            <option value="2">Medium (2px)</option>
                            <option value="3">Strong (3px)</option>
                        </select>
                    </div>
                    <div style="flex: 1; font-size: 11px; display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; padding-bottom: 2px;">
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #94a3b8;">
                            <input type="checkbox" id="db-fill-bg" style="accent-color: #a78bfa;"> Fill background
                        </label>
                        <label id="db-bridge-wrapper" style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #94a3b8;">
                            <input type="checkbox" id="db-use-bridge" checked style="accent-color: #a78bfa;"> Smart Bridges
                        </label>
                    </div>
                </div>

                <div id="db-status-container" style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 8px; margin-bottom: 12px; font-size: 11px; line-height: 1.4;">
                    <div id="db-status" style="font-weight: 600; color: #94a3b8;">Waiting for image...</div>
                    <div id="db-progress-wrapper" style="display: none; margin-top: 8px;">
                        <div style="background: rgba(255,255,255,0.08); height: 6px; border-radius: 3px; overflow: hidden; margin-bottom: 4px; border: 1px solid rgba(255,255,255,0.05);">
                            <div id="db-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #a78bfa, #818cf8); transition: width 0.1s;"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; font-weight: 500;">
                            <span id="db-progress-percent">0%</span>
                            <span id="db-progress-time">Remaining: ~0s</span>
                        </div>
                    </div>
                </div>

                <div id="db-log-container" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 8px; margin-bottom: 12px; font-size: 10px; line-height: 1.4; display: none; max-height: 80px; overflow-y: auto;">
                    <div style="font-weight: bold; color: #ef4444; margin-bottom: 4px;">Error log:</div>
                    <div id="db-log-content" style="color: #fca5a5; font-family: monospace; white-space: pre-wrap; font-size: 9px;"></div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button id="db-start" style="width: 100%; padding: 10px; background: #4f46e5; border: none; color: white; font-weight: 600; border-radius: 8px; cursor: pointer; transition: background 0.2s, transform 0.1s; font-size: 12px; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.3);">▶ Start Drawing</button>
                    <div style="display: flex; gap: 8px;">
                        <button id="db-pause" style="flex: 1; padding: 8px; background: #d97706; border: none; color: white; font-weight: 600; border-radius: 8px; cursor: pointer; transition: background 0.2s; font-size: 11px; display: none;">⏸ Pause</button>
                        <button id="db-cancel" style="flex: 1; padding: 8px; background: #b91c1c; border: none; color: white; font-weight: 600; border-radius: 8px; cursor: pointer; transition: background 0.2s; font-size: 11px; display: none;">⏹ Cancel</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // Load saved settings
        const savedSetting = loadSettings();
        if (savedSetting) {
            applySavedValue('db-scale', savedSetting.scale);
            applySavedValue('db-colors-mode', savedSetting.colorsMode);
            applySavedValue('db-draw-mode', savedSetting.drawMode);
            applySavedValue('db-batch-size', savedSetting.batchSize);
            applySavedValue('db-delay', savedSetting.delay);
            applySavedValue('db-fill-pps', savedSetting.fillPPS);
            applySavedValue('db-denoise-level', savedSetting.denoise);
            applySavedValue('db-fill-bg', savedSetting.fillBg);
            applySavedValue('db-use-bridge', savedSetting.useBridge);
            applySavedValue('db-bridge-len', savedSetting.bridgeLen);
            if (['stretch', 'center', 'custom'].includes(savedSetting.layoutMode)) layoutMode = savedSetting.layoutMode;
            if (Number.isFinite(savedSetting.customX)) customX = savedSetting.customX;
            if (Number.isFinite(savedSetting.customY)) customY = savedSetting.customY;
            if (Number.isFinite(savedSetting.customW)) customW = savedSetting.customW;
            if (Number.isFinite(savedSetting.customH)) customH = savedSetting.customH;
            clampCustomBounds();
        }

        if (document.getElementById('db-layout-mode')) {
            document.getElementById('db-layout-mode').value = layoutMode;
            if (layoutMode === 'custom') {
                document.getElementById('db-custom-sliders').style.display = 'block';
            }
        }

        // Make draggable
        makeDraggable(panel, panel);

        // Event Listeners
        const minimizeBtn = document.getElementById('db-minimize-btn');
        const contentDiv = document.getElementById('db-content');
        let isMinimized = false;
        minimizeBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                contentDiv.style.display = 'none';
                minimizeBtn.textContent = '➕';
                panel.style.width = '180px';
            } else {
                contentDiv.style.display = 'block';
                minimizeBtn.textContent = '➖';
                panel.style.width = '280px';
            }
        });

        const urlInput = document.getElementById('db-url');

        // Debounced preview: rendering is heavy, so wait until the user stops typing or clicking
        let previewTimer = null;
        const schedulePreview = () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(() => processAndPreviewImage(currentImageSrc), PREVIEW_DEBOUNCE_MS);
        };

        // Single entry point for every image source: file picker, URL, paste, drag & drop
        const setImageSource = (src, label) => {
            currentImageSrc = src;
            isApplied = false;
            if (label !== undefined) urlInput.value = label;
            updateStatus('Loading image...', '#fbbf24');
            loadImage(src).then(img => {
                if (currentImageSrc !== src) return; // replaced by a newer image meanwhile
                draftImg = img;
                // Fit the custom box to the image proportions, centered
                const imgRatio = img.width / img.height;
                const canvasRatio = 768 / 448;
                if (imgRatio > canvasRatio) {
                    customW = 400;
                    customH = Math.round(400 / imgRatio);
                } else {
                    customH = 250;
                    customW = Math.round(250 * imgRatio);
                }
                customX = Math.round((768 - customW) / 2);
                customY = Math.round((448 - customH) / 2);
                clampCustomBounds();
                updateSliders();

                if (layoutMode === 'custom') {
                    drawDraftPreview();
                } else {
                    processAndPreviewImage(src);
                }
                updateStatus('Image loaded. Click Start.', '#a78bfa');
            }).catch(() => {
                if (currentImageSrc !== src) return;
                // warn, not error: half-typed URLs fail all the time and must not flood the log
                console.warn('[DrawBot] Could not load image:', src.slice(0, 100));
                updateStatus('❌ Could not load image. If it is a link, download it and use 📁 instead.', '#ef4444');
            });
        };

        const loadImageFile = (file) => {
            if (!file || !file.type.startsWith('image/')) {
                updateStatus('❌ Not an image file', '#ef4444');
                return;
            }
            const reader = new FileReader();
            reader.onload = (event) => setImageSource(event.target.result, file.name);
            reader.onerror = () => updateStatus('❌ Could not read the file', '#ef4444');
            reader.readAsDataURL(file);
        };

        // File loading
        const fileBtn = document.getElementById('db-file-btn');
        const fileInput = document.getElementById('db-file');
        fileBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            loadImageFile(e.target.files[0]);
            fileInput.value = ''; // allow picking the same file again
        });

        // URL loading
        let urlTimer = null;
        urlInput.addEventListener('input', () => {
            clearTimeout(urlTimer);
            urlTimer = setTimeout(() => {
                const val = urlInput.value.trim();
                if (val && (val.startsWith('http') || val.startsWith('data:'))) {
                    setImageSource(val);
                }
            }, PREVIEW_DEBOUNCE_MS);
        });

        // Paste an image (Ctrl+V) anywhere on the page
        window.addEventListener('paste', (e) => {
            const target = e.target;
            const inGameTextField = target && target.closest && !target.closest('#db-panel') &&
                (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName));
            if (inGameTextField) return; // leave pastes into the game's own fields alone
            const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
            const imageItem = items.find(item => item.kind === 'file' && item.type.startsWith('image/'));
            if (!imageItem) return; // plain text goes to the focused field as usual
            e.preventDefault();
            loadImageFile(imageItem.getAsFile());
        }, true);

        // Drag & drop an image file, or an image dragged from another tab, onto the panel
        panel.addEventListener('dragover', (e) => {
            e.preventDefault();
            panel.classList.add('db-drop-active');
        });
        panel.addEventListener('dragleave', (e) => {
            if (!panel.contains(e.relatedTarget)) panel.classList.remove('db-drop-active');
        });
        panel.addEventListener('drop', (e) => {
            e.preventDefault();
            panel.classList.remove('db-drop-active');
            const dt = e.dataTransfer;
            if (!dt) return;
            const file = Array.from(dt.files || []).find(f => f.type.startsWith('image/'));
            if (file) {
                loadImageFile(file);
                return;
            }
            const url = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n')[0].trim();
            if (url.startsWith('http') || url.startsWith('data:')) {
                setImageSource(url, url);
            } else {
                updateStatus('❌ Drop an image file or an image link', '#ef4444');
            }
        });

        // Preview updating triggers
        const handleTriggerUpdate = () => {
            saveSettings();
            isApplied = false;
            if (layoutMode === 'custom') {
                drawDraftPreview();
            } else {
                schedulePreview();
            }
        };

        ['db-scale', 'db-colors-mode', 'db-denoise-level', 'db-fill-bg', 'db-use-bridge', 'db-draw-mode'].forEach(id => {
            document.getElementById(id).addEventListener('change', handleTriggerUpdate);
        });
        // Number fields: their values are read and clamped by readDrawOptions()
        ['db-batch-size', 'db-delay', 'db-fill-pps', 'db-bridge-len'].forEach(id => {
            document.getElementById(id).addEventListener('input', handleTriggerUpdate);
        });

        // Show/hide PPS and Delay depending on drawing mode
        const drawModeSelect = document.getElementById('db-draw-mode');
        const batchWrapper = document.getElementById('db-batch-wrapper');
        const fillPPSWrapper = document.getElementById('db-fill-pps-wrapper');
        const delayWrapper = document.getElementById('db-delay-wrapper');
        const bridgeWrapper = document.getElementById('db-bridge-wrapper');
        const bridgeLenWrapper = document.getElementById('db-bridge-len-wrapper');
        const useBridgeCheckbox = document.getElementById('db-use-bridge');
        const updateFillPPSVisibility = () => {
            const isFill = drawModeSelect.value === 'fill';
            const useBridge = useBridgeCheckbox ? useBridgeCheckbox.checked : false;
            if (fillPPSWrapper) fillPPSWrapper.style.display = isFill ? 'flex' : 'none';
            if (delayWrapper) delayWrapper.style.display = isFill ? 'none' : 'flex';
            if (bridgeWrapper) bridgeWrapper.style.display = isFill ? 'flex' : 'none';
            if (bridgeLenWrapper) bridgeLenWrapper.style.display = (isFill && useBridge) ? 'flex' : 'none';
            if (batchWrapper) batchWrapper.style.display = isFill ? 'block' : 'none';
        };
        drawModeSelect.addEventListener('change', updateFillPPSVisibility);
        if (useBridgeCheckbox) useBridgeCheckbox.addEventListener('change', updateFillPPSVisibility);
        updateFillPPSVisibility();

        // Round (turn ID): auto-detected, can be overridden by hand
        const turnInput = document.getElementById('db-turn-id');
        const turnAutoCheckbox = document.getElementById('db-turn-auto');
        if (turnInput && turnAutoCheckbox) {
            turnInput.value = turnIdToRound(CFG.currentTurnId);
            turnAutoCheckbox.checked = turnIdAuto;
            turnInput.addEventListener('input', () => {
                const round = parseInt(turnInput.value, 10);
                if (isNaN(round) || round < 1) return;
                // A hand-typed value must not be overwritten by the next captured packet
                turnIdAuto = false;
                turnAutoCheckbox.checked = false;
                applyTurnId(roundToTurnId(round));
                console.log('[DrawBot] Round set manually:', round, '(turnId', CFG.currentTurnId + ')');
            });
            turnAutoCheckbox.addEventListener('change', () => {
                turnIdAuto = turnAutoCheckbox.checked;
                console.log('[DrawBot] Round auto-detection:', turnIdAuto ? 'on' : 'off');
            });
        }

        // Layout change handler
        const layoutSelect = document.getElementById('db-layout-mode');
        const customSliders = document.getElementById('db-custom-sliders');

        if (layoutSelect) {
            layoutSelect.addEventListener('change', () => {
                layoutMode = layoutSelect.value;
                saveSettings();
                isApplied = false;
                if (layoutMode === 'custom') {
                    if (customSliders) customSliders.style.display = 'block';
                    updateSliders();
                    drawDraftPreview();
                } else {
                    if (customSliders) customSliders.style.display = 'none';
                    processAndPreviewImage(currentImageSrc);
                }
            });
        }

        // Sliders input handlers
        const wSlider = document.getElementById('db-custom-w');
        const hSlider = document.getElementById('db-custom-h');
        const xSlider = document.getElementById('db-custom-x');
        const ySlider = document.getElementById('db-custom-y');

        const onSliderInput = () => {
            if (wSlider) customW = parseInt(wSlider.value, 10);
            if (hSlider) customH = parseInt(hSlider.value, 10);
            if (xSlider) customX = parseInt(xSlider.value, 10);
            if (ySlider) customY = parseInt(ySlider.value, 10);

            clampCustomBounds();
            updateSliders();
            drawDraftPreview();
            isApplied = false;
        };

        [wSlider, hSlider, xSlider, ySlider].forEach(slider => {
            if (slider) slider.addEventListener('input', onSliderInput);
        });

        const customApplyBtn = document.getElementById('db-custom-apply');
        if (customApplyBtn) {
            customApplyBtn.addEventListener('click', () => {
                saveSettings();
                processAndPreviewImage(currentImageSrc);
            });
        }

        // Canvas dragging listener
        const pCanvas = document.getElementById('db-preview-canvas');
        if (pCanvas) {
            pCanvas.addEventListener('mousedown', handleCanvasMouseDown);
            pCanvas.addEventListener('mousemove', handleCanvasMouseMoveNoDrag);
        }

        // Drawing control triggers
        document.getElementById('db-start').addEventListener('click', () => {
            if (!currentImageSrc) {
                alert('Please load an image first (file, URL, Ctrl+V or drag & drop)!');
                return;
            }
            runDraw();
        });

        const pauseBtn = document.getElementById('db-pause');
        pauseBtn.addEventListener('click', () => {
            isPaused = !isPaused;
            debugLog('[DrawBot] Pause toggled:', isPaused);
            if (isPaused) {
                pauseBtn.textContent = '▶ Resume';
                pauseBtn.style.background = '#059669';
                updateStatus('⏸ Pause', '#fbbf24');
            } else {
                pauseBtn.textContent = '⏸ Pause';
                pauseBtn.style.background = '#d97706';
                updateStatus('Drawing...', '#a78bfa');
            }
        });

        document.getElementById('db-cancel').addEventListener('click', () => {
            debugLog('[DrawBot] Cancel requested.');
            cancelFlag = true;
            isPaused = false;
        });

        // Hook initial websocket check
        if (wsInstance) {
            updateStatus('Socket ready. Select a file/URL and click Start.', '#10b981');
        } else {
            updateStatus('Waiting for game connection...', '#94a3b8');
        }
    }

    function makeDraggable(el, header) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        header.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            if (e.target.closest('button, input, select, canvas, label, a')) return;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            el.style.top = (el.offsetTop - pos2) + "px";
            el.style.left = (el.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    // Initialize UI
    function init() {
        buildUI();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
