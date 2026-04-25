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
                const isOnline = (lastHB !== 0 && (now - lastHB) <= HEARTBEAT_THRESHOLD_MS);
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

                monitors.push({
                    id: deviceId,
                    name: device.name || "Unknown Area",
                    lastHeartbeat: lastHB,
                    lastBootTime: bootTime,
                    deviceIP: device.deviceIP || "N/A",
                    totalLoadShedding24h: totalOutageMins24h,
                    history: deviceHistory
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
        // Is offline if heartbeat is missing or older than 2 minutes
        const timeSinceBeat = now - monitor.lastHeartbeat;
        monitor.isOnline = (monitor.lastHeartbeat !== 0 && timeSinceBeat <= HEARTBEAT_THRESHOLD_MS);

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
                    <span>Last Signal Received</span>
                    <span><i class="fa-solid fa-tower-broadcast"></i> ${timeAgo(monitor.lastHeartbeat)}</span>
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
