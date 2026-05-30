import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getDatabase, ref, onValue, set, get, child } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

// Firebase Configuration from your input
const firebaseConfig = {
  apiKey: "AIzaSyBgqF29FrfApthkf7Zy-maOKuqyREenCwU",
  authDomain: "khamba-ache-current-nai.firebaseapp.com",
  projectId: "khamba-ache-current-nai",
  databaseURL: "https://khamba-ache-current-nai-default-rtdb.asia-southeast1.firebasedatabase.app/",
  storageBucket: "khamba-ache-current-nai.firebasestorage.app",
  messagingSenderId: "261680589066",
  appId: "1:261680589066:web:647367353946b0ac7972f3",
  measurementId: "G-LB6MC2M9EL"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// State variables
let monitors = [];
let chartInstance = null; // Holds the Chart.js instance for the drawer
const HEARTBEAT_THRESHOLD_MS = 2.5 * 60 * 1000; // 2.5 minutes (ESP sends every 1 min, so ±1 min accuracy)

// DOM Elements
const grid = document.getElementById('monitorsGrid');
const totalMonitorsEl = document.getElementById('totalMonitors');
const currentOutagesEl = document.getElementById('currentOutages');
const avgOutageEl = document.getElementById('avgOutage');
const filterBtns = document.querySelectorAll('.filter-btn');

const modal = document.getElementById('addDeviceModal');
const addDeviceBtn = document.getElementById('addDeviceBtn');
const closeBtn = document.querySelector('.close-btn');
const addDeviceForm = document.getElementById('addDeviceForm');

// Drawer Elements
const drawer = document.getElementById('historyDrawer');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');
const drawerOverlay = document.querySelector('.drawer-overlay');
const dAreaName = document.getElementById('drawerAreaName');
const dDeviceId = document.querySelector('#drawerDeviceId span');
const dTotalOutage = document.getElementById('drawerTotalOutage');
const dStatus = document.getElementById('drawerStatus');
const dTimeline = document.getElementById('historyTimeline');

// Initialization
function initDashboard() {
    setupEventListeners();
    fetchRealtimeData();
    
    // Check status locally every 10 seconds to update UI times
    setInterval(updateSystemStatus, 10000);
}

// Fetch Data from Firebase
function fetchRealtimeData() {
    const dbRef = ref(database, 'devices');
    onValue(dbRef, (snapshot) => {
        const data = snapshot.val();
        monitors = [];
        
        if (data) {
            Object.keys(data).forEach(deviceId => {
                const device = data[deviceId];
                const lastHB = device.lastHeartbeat || 0;
                const bootTime = device.lastBootTime || 0;
                const now = new Date().getTime();
                
                // ESP থেকে আসা আসল Outage ইতিহাস পড়ো
                let deviceHistory = [];
                let totalOutageMins24h = 0;
                const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
                
                if (device.history) {
                    // Firebase-এর history নোড থেকে সব entry পড়ো
                    const entries = Object.values(device.history);
                    
                    // নতুন থেকে পুরনো অনুযায়ী সাজাও
                    entries.sort((a, b) => (b.restoredTime || b.cutTime || 0) - (a.restoredTime || a.cutTime || 0));
                    
                    entries.forEach(entry => {
                        if (entry.type === 'outage') {
                            // প্রতিটি outage ইভেন্টকে ২টি timeline item এ ভাগ করো
                            deviceHistory.push({
                                type: 'power-restored',
                                time: entry.restoredTime,
                                duration: formatDuration(entry.durationMins || 0)
                            });
                            deviceHistory.push({
                                type: 'power-cut',
                                time: entry.cutTime,
                                duration: ''
                            });
                            
                            // গত ২৪ ঘণ্টার মোট outage হিসাব
                            if (entry.cutTime >= twentyFourHoursAgo) {
                                totalOutageMins24h += (entry.durationMins || 0);
                            }
                        }
                    });
                }
                
                // যদি এই মুহূর্তে offline থাকে, বর্তমান outage duration যোগ করো
                const isOnline = device.status ? (device.status === 'online') : (lastHB !== 0 && (now - lastHB) <= HEARTBEAT_THRESHOLD_MS);
                if (!isOnline && lastHB > 0) {
                    const currentOutageMins = Math.floor((now - lastHB) / 60000);
                    totalOutageMins24h += currentOutageMins;
                    
                    // বর্তমান চলমান outage টাইমলাইনে দেখাও
                    deviceHistory.unshift({
                        type: 'power-cut',
                        time: lastHB,
                        duration: `Ongoing (${formatDuration(currentOutageMins)})`
                    });
                }

                let rawOutages = [];
                if (device.history) {
                    rawOutages = Object.values(device.history);
                }

                monitors.push({
                    id: deviceId,
                    name: device.name || "Unknown Area",
                    lastHeartbeat: lastHB,
                    lastBootTime: bootTime,
                    deviceIP: device.publicIP || device.localIP || device.deviceIP || "N/A",
                    totalLoadShedding24h: totalOutageMins24h,
                    history: deviceHistory,
                    rawOutages: rawOutages,
                    status: device.status || (isOnline ? 'online' : 'offline')
                });
            });
        }
        
        updateSystemStatus();
    });
}

// Format duration
function formatDuration(minutes) {
    if (minutes === 0) return "0m";
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return `${h > 0 ? h + 'h ' : ''}${m}m`;
}

// Format time ago
function timeAgo(timestamp) {
    if(!timestamp || timestamp === 0) return "Never";
    
    const seconds = Math.floor((new Date() - timestamp) / 1000);
    
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
    return 'Over 24h ago';
}

// Format exact date & time
function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    const dateOpts = { month: 'short', day: 'numeric' };
    const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true };
    return `${d.toLocaleDateString(undefined, dateOpts)} at ${d.toLocaleTimeString(undefined, timeOpts)}`;
}

// Check status logic
function updateSystemStatus() {
    const now = new Date().getTime();
    let outages = 0;
    let totalOutageMins = 0;

    monitors.forEach(monitor => {
        // Status is checked directly from the status property updated via onDisconnect
        monitor.isOnline = (monitor.status === 'online');

        if (!monitor.isOnline) outages++;
        totalOutageMins += monitor.totalLoadShedding24h;
    });

    // Update Top Stats
    totalMonitorsEl.textContent = monitors.length;
    currentOutagesEl.textContent = outages;
    
    const avgMins = monitors.length > 0 ? totalOutageMins / monitors.length : 0;
    avgOutageEl.textContent = formatDuration(avgMins);

    // Keep the selected filter active
    const activeBtn = document.querySelector('.filter-btn.active');
    const activeFilter = activeBtn ? activeBtn.dataset.filter : 'all';
    renderMonitors(activeFilter);
}

// Render grid visually
function renderMonitors(filter) {
    grid.innerHTML = '';
    
    const filteredMonitors = monitors.filter(m => {
        if (filter === 'all') return true;
        if (filter === 'online') return m.isOnline;
        if (filter === 'offline') return !m.isOnline;
        return true;
    });

    if (filteredMonitors.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 2rem;">No monitors available. Add one using the + button.</div>`;
        return;
    }

    filteredMonitors.forEach(monitor => {
        const statusClass = monitor.isOnline ? 'status-online' : 'status-offline';
        const statusText = monitor.isOnline ? 'Power ON' : 'Load Shedding Active';
        
        // dynamic labels based on online/offline state
        const signalLabel = monitor.isOnline ? 'Connected Since' : 'Power Cut Since';
        const signalTime = monitor.isOnline ? timeAgo(monitor.lastBootTime) : timeAgo(monitor.lastHeartbeat);
        const signalIcon = monitor.isOnline ? 'fa-circle-check' : 'fa-plug-circle-xmark';

        const card = document.createElement('div');
        card.className = `monitor-card glass-panel ${statusClass}`;
        
        card.innerHTML = `
            <div class="card-header">
                <div class="area-info">
                    <h3>${monitor.name}</h3>
                    <span class="device-id"><i class="fa-solid fa-microchip"></i> ${monitor.id}</span>
                </div>
                <div class="status-badge">
                    <span class="status-indicator"></span>
                    ${statusText}
                </div>
            </div>
            
            <div class="card-stats">
                <div class="c-stat">
                    <span>${signalLabel}</span>
                    <span><i class="fa-solid ${signalIcon}"></i> ${signalTime}</span>
                </div>
                <div class="c-stat" style="text-align:right;">
                    <span>Outage (Last 24h)</span>
                    <span><i class="fa-regular fa-clock"></i> ${formatDuration(monitor.totalLoadShedding24h)}</span>
                </div>
            </div>
        `;
        
        card.addEventListener('click', () => openHistoryDrawer(monitor));
        grid.appendChild(card);
    });
}

// Drawer functionality
function openHistoryDrawer(monitor) {
    dAreaName.textContent = monitor.name;
    dDeviceId.textContent = monitor.id;
    dTotalOutage.textContent = formatDuration(monitor.totalLoadShedding24h);
    
    if (monitor.isOnline) {
        dStatus.textContent = "Power ON";
        dStatus.className = "status-badge status-online";
        dStatus.style.background = "rgba(16, 185, 129, 0.15)";
        dStatus.style.color = "var(--success)";
        dStatus.style.border = "1px solid rgba(16, 185, 129, 0.3)";
    } else {
        dStatus.textContent = "Load Shedding";
        dStatus.className = "status-badge status-offline";
        dStatus.style.background = "rgba(239, 68, 68, 0.15)";
        dStatus.style.color = "var(--danger)";
        dStatus.style.border = "1px solid rgba(239, 68, 68, 0.3)";
    }

    // IP Address দেখাও (ভেরিফিকেশনের জন্য)
    const ipEl = document.getElementById('drawerDeviceIP');
    if (ipEl) ipEl.textContent = monitor.deviceIP;

    const now = new Date().getTime();

    // ──────────────────────────────────────────────
    // ১. ২৪ ঘণ্টার পাওয়ার বার (Availability Strip) রেন্ডার করো
    // ──────────────────────────────────────────────
    const availabilityBar = document.getElementById('availabilityBar');
    if (availabilityBar) {
        availabilityBar.innerHTML = '';
        const oneHour = 60 * 60 * 1000;
        
        // ২৪টি ব্লক জেনারেট করো (২৩ ঘণ্টা আগে থেকে বর্তমান ঘণ্টা পর্যন্ত)
        for (let i = 23; i >= 0; i--) {
            const slotStart = now - (i + 1) * oneHour;
            const slotEnd = now - i * oneHour;
            let offlineMins = 0;
            
            // আউটেজ চেক
            if (monitor.rawOutages) {
                monitor.rawOutages.forEach(outage => {
                    const cut = outage.cutTime;
                    const restored = outage.restoredTime || now;
                    
                    const overlapStart = Math.max(cut, slotStart);
                    const overlapEnd = Math.min(restored, slotEnd);
                    
                    if (overlapStart < overlapEnd) {
                        offlineMins += (overlapEnd - overlapStart) / 60000;
                    }
                });
            }
            
            // রানিং অফলাইন ইভেন্ট
            if (monitor.status !== 'online' && monitor.lastHeartbeat > 0) {
                const cut = monitor.lastHeartbeat;
                const restored = now;
                
                const overlapStart = Math.max(cut, slotStart);
                const overlapEnd = Math.min(restored, slotEnd);
                
                if (overlapStart < overlapEnd) {
                    offlineMins += (overlapEnd - overlapStart) / 60000;
                }
            }
            
            const dateObj = new Date(slotStart);
            const timeLabel = dateObj.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const block = document.createElement('div');
            block.className = 'availability-block';
            
            if (offlineMins > 2) {
                block.classList.add('offline');
                block.setAttribute('data-tooltip', `${timeLabel}: Load Shedding (${Math.round(offlineMins)}m)`);
            } else {
                block.classList.add('online');
                block.setAttribute('data-tooltip', `${timeLabel}: Power Available`);
            }
            availabilityBar.appendChild(block);
        }
    }

    // ──────────────────────────────────────────────
    // ২. ৭ দিনের ট্রেন্ড চার্ট (Chart.js) রেন্ডার করো
    // ──────────────────────────────────────────────
    const chartLabels = [];
    const chartData = [];
    const dayMs = 24 * 60 * 60 * 1000;
    
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * dayMs);
        const label = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        chartLabels.push(label);
        
        const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const endOfDay = startOfDay + dayMs;
        let dayOfflineMins = 0;
        
        if (monitor.rawOutages) {
            monitor.rawOutages.forEach(outage => {
                const cut = outage.cutTime;
                const restored = outage.restoredTime || now;
                
                const overlapStart = Math.max(cut, startOfDay);
                const overlapEnd = Math.min(restored, endOfDay);
                
                if (overlapStart < overlapEnd) {
                    dayOfflineMins += (overlapEnd - overlapStart) / 60000;
                }
            });
        }
        
        if (monitor.status !== 'online' && monitor.lastHeartbeat > 0) {
            const cut = monitor.lastHeartbeat;
            const restored = now;
            
            const overlapStart = Math.max(cut, startOfDay);
            const overlapEnd = Math.min(restored, endOfDay);
            
            if (overlapStart < overlapEnd) {
                dayOfflineMins += (overlapEnd - overlapStart) / 60000;
            }
        }
        
        const hours = (dayOfflineMins / 60).toFixed(1);
        chartData.push(parseFloat(hours));
    }
    
    // চার্ট রিস্টার্ট
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
    
    const chartCanvas = document.getElementById('outageChart');
    if (chartCanvas) {
        const ctx = chartCanvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 150);
        gradient.addColorStop(0, 'rgba(239, 68, 68, 0.8)');   // Red glow top
        gradient.addColorStop(1, 'rgba(239, 68, 68, 0.05)');  // Fade bottom
        
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: 'Outage Hours',
                    data: chartData,
                    backgroundColor: gradient,
                    borderColor: '#ef4444',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return ` Outage: ${context.raw}h`;
                            }
                        },
                        backgroundColor: 'rgba(15, 18, 30, 0.95)',
                        titleColor: '#fff',
                        bodyColor: '#cbd5e1',
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        borderWidth: 1,
                        titleFont: { family: "'Outfit', sans-serif" },
                        bodyFont: { family: "'Outfit', sans-serif" }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#94a3b8',
                            font: { family: "'Outfit', sans-serif", size: 10 }
                        }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: {
                            color: '#94a3b8',
                            font: { family: "'Outfit', sans-serif", size: 10 },
                            stepSize: 1,
                            callback: function(value) { return value + 'h'; }
                        },
                        min: 0
                    }
                }
            }
        });
    }

    // ──────────────────────────────────────────────
    // ৩. হিস্ট্রি টাইমলাইন রেন্ডার করো
    // ──────────────────────────────────────────────
    dTimeline.innerHTML = '';
    
    if (!monitor.history || monitor.history.length === 0) {
        dTimeline.innerHTML = `<div style="color: var(--text-secondary);">No outage history available yet.</div>`;
    } else {
        monitor.history.forEach(evt => {
            const isCut = evt.type === 'power-cut';
            const html = `
                <div class="timeline-item ${evt.type}">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <div class="timeline-header">
                            <span class="timeline-title">
                                ${isCut ? '<i class="fa-solid fa-bolt-slash"></i> Power Outage' : '<i class="fa-solid fa-bolt"></i> Power Restored'}
                            </span>
                            <span class="timeline-date">${formatDateTime(evt.time)}</span>
                        </div>
                        ${evt.duration ? `<div class="timeline-duration"><i class="fa-regular fa-clock"></i> Duration: ${evt.duration}</div>` : ''}
                    </div>
                </div>
            `;
            dTimeline.innerHTML += html;
        });
    }

    drawer.classList.add('active');
}

// Bind Events
function setupEventListeners() {
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderMonitors(e.target.dataset.filter);
        });
    });

    addDeviceBtn.addEventListener('click', () => {
        modal.classList.add('active');
    });
    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });

    closeDrawerBtn.addEventListener('click', () => {
        drawer.classList.remove('active');
    });
    drawerOverlay.addEventListener('click', () => {
        drawer.classList.remove('active');
    });

    // Form: Create a new device inside Firebase
    addDeviceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const name = document.getElementById('areaName').value.trim();
        const id = document.getElementById('deviceId').value.trim();
        
        // Check for duplicates
        const exists = monitors.find(m => m.id === id);
        if (exists) {
            alert(`Error: A device with ID '${id}' is already registered! Please use a unique Device ID.`);
            return;
        }
        
        // Write the new device to Firebase Database
        const newDeviceRef = ref(database, 'devices/' + id);
        set(newDeviceRef, {
            name: name,
            lastHeartbeat: 0 // Will be updated by ESP8266
        }).then(() => {
            addDeviceForm.reset();
            modal.classList.remove('active');
            // Check 'all' filter
            document.querySelector('[data-filter="all"]').click();
        }).catch((error) => {
            console.error("Error adding device: ", error);
            alert("Failed to add device. Check console.");
        });
    });
}

document.addEventListener('DOMContentLoaded', initDashboard);
