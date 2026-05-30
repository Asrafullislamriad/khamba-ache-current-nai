import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

// Firebase Configuration
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

// State & Constants
let chartInstance = null;
const HEARTBEAT_THRESHOLD_MS = 2.5 * 60 * 1000;

// URL Parameters
const urlParams = new URLSearchParams(window.location.search);
const deviceId = urlParams.get('id');

// If no device ID is provided, redirect to dashboard
if (!deviceId) {
    window.location.href = "index.html";
} else {
    initDeviceDetails();
}

function initDeviceDetails() {
    const deviceRef = ref(database, 'devices/' + deviceId);
    onValue(deviceRef, (snapshot) => {
        const device = snapshot.val();
        
        if (!device) {
            document.getElementById('loadingState').innerHTML = `
                <div style="padding: 2rem; color: var(--danger); text-align: center;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size: 3rem; margin-bottom: 1rem;"></i>
                    <h2>Device Not Found</h2>
                    <p style="margin: 0.5rem 0 1.5rem 0; color: var(--text-secondary);">The device ID '${deviceId}' is not registered in the system.</p>
                    <a href="index.html" class="back-btn-details" style="display: inline-block;">Go Back to Dashboard</a>
                </div>
            `;
            return;
        }

        // Hide loading state, show details grid
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('detailsGrid').style.display = 'grid';

        const name = device.name || "Unknown Area";
        const lastHB = device.lastHeartbeat || 0;
        const bootTime = device.lastBootTime || 0;
        const status = device.status;
        const now = new Date().getTime();

        // Render basic titles
        document.getElementById('areaName').textContent = name;
        document.getElementById('deviceId').innerHTML = `<i class="fa-solid fa-microchip"></i> ${deviceId}`;

        // isOnline backward-compatible calculation
        const isOnline = status ? (status === 'online') : (lastHB !== 0 && (now - lastHB) <= HEARTBEAT_THRESHOLD_MS);

        // Render Status Card
        const statusCard = document.getElementById('statusCard');
        const statusBadge = document.getElementById('statusBadge');
        const statusText = document.getElementById('statusText');
        const durationLabel = document.getElementById('statusDurationLabel');
        const durationVal = document.getElementById('statusDuration');

        if (isOnline) {
            statusCard.className = "status-card-large glass-panel status-online";
            statusText.textContent = "Power ON";
            statusBadge.className = "status-badge-large status-online";
            durationLabel.textContent = "Uptime Duration (Connected Since)";
            durationVal.innerHTML = `<i class="fa-solid fa-circle-check" style="margin-right: 0.4rem; color: var(--success);"></i> ${timeAgo(bootTime)}`;
        } else {
            statusCard.className = "status-card-large glass-panel status-offline";
            statusText.textContent = "Load Shedding";
            statusBadge.className = "status-badge-large status-offline";
            durationLabel.textContent = "Outage Duration (Power Cut Since)";
            durationVal.innerHTML = `<i class="fa-solid fa-plug-circle-xmark" style="margin-right: 0.4rem; color: var(--danger);"></i> ${timeAgo(lastHB)}`;
        }

        // Render IP details
        document.getElementById('publicIP').textContent = device.publicIP || "N/A";
        document.getElementById('localIP').textContent = device.localIP || device.deviceIP || "N/A";

        // Parse Outages & History
        let deviceHistory = [];
        let totalOutageMins24h = 0;
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
        let rawOutages = [];

        if (device.history) {
            rawOutages = Object.values(device.history);
            // Sort raw outages by cutTime descending (newest first)
            rawOutages.sort((a, b) => (b.restoredTime || b.cutTime || 0) - (a.restoredTime || a.cutTime || 0));

            rawOutages.forEach(entry => {
                if (entry.type === 'outage') {
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
                    
                    if (entry.cutTime >= twentyFourHoursAgo) {
                        totalOutageMins24h += (entry.durationMins || 0);
                    }
                }
            });
        }

        if (!isOnline && lastHB > 0) {
            const currentOutageMins = Math.floor((now - lastHB) / 60000);
            totalOutageMins24h += currentOutageMins;
            
            deviceHistory.unshift({
                type: 'power-cut',
                time: lastHB,
                duration: `Ongoing (${formatDuration(currentOutageMins)})`
            });
        }

        // Render Total 24h Outage
        document.getElementById('totalOutage24h').textContent = formatDuration(totalOutageMins24h);

        // ──────────────────────────────────────────────
        // ১. ২৪ ঘণ্টার পাওয়ার বার (Availability Strip)
        // ──────────────────────────────────────────────
        const availabilityBar = document.getElementById('availabilityBar');
        if (availabilityBar) {
            availabilityBar.innerHTML = '';
            const oneHour = 60 * 60 * 1000;
            
            for (let i = 23; i >= 0; i--) {
                const slotStart = now - (i + 1) * oneHour;
                const slotEnd = now - i * oneHour;
                let offlineMins = 0;
                
                rawOutages.forEach(outage => {
                    const cut = outage.cutTime;
                    const restored = outage.restoredTime || now;
                    
                    const overlapStart = Math.max(cut, slotStart);
                    const overlapEnd = Math.min(restored, slotEnd);
                    
                    if (overlapStart < overlapEnd) {
                        offlineMins += (overlapEnd - overlapStart) / 60000;
                    }
                });
                
                if (!isOnline && lastHB > 0) {
                    const cut = lastHB;
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
        // ২. ৭ দিনের ট্রেন্ড চার্ট (Chart.js)
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
            
            rawOutages.forEach(outage => {
                const cut = outage.cutTime;
                const restored = outage.restoredTime || now;
                
                const overlapStart = Math.max(cut, startOfDay);
                const overlapEnd = Math.min(restored, endOfDay);
                
                if (overlapStart < overlapEnd) {
                    dayOfflineMins += (overlapEnd - overlapStart) / 60000;
                }
            });
            
            if (!isOnline && lastHB > 0) {
                const cut = lastHB;
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

        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        
        const chartCanvas = document.getElementById('outageChart');
        if (chartCanvas) {
            const ctx = chartCanvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 200);
            gradient.addColorStop(0, 'rgba(239, 68, 68, 0.85)');
            gradient.addColorStop(1, 'rgba(239, 68, 68, 0.05)');
            
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
                        borderRadius: 8,
                        barPercentage: 0.55
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
                                font: { family: "'Outfit', sans-serif", size: 11 }
                            }
                        },
                        y: {
                            grid: { color: 'rgba(255, 255, 255, 0.05)' },
                            ticks: {
                                color: '#94a3b8',
                                font: { family: "'Outfit', sans-serif", size: 11 },
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
        const historyTimeline = document.getElementById('historyTimeline');
        if (historyTimeline) {
            historyTimeline.innerHTML = '';
            
            if (deviceHistory.length === 0) {
                historyTimeline.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 2rem 0;">No outage history available yet.</div>`;
            } else {
                deviceHistory.forEach(evt => {
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
                    historyTimeline.innerHTML += html;
                });
            }
        }
    });
}

// Utility Functions
function formatDuration(minutes) {
    if (minutes === 0) return "0m";
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return `${h > 0 ? h + 'h ' : ''}${m}m`;
}

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

function formatDateTime(timestamp) {
    const d = new Date(timestamp);
    const dateOpts = { month: 'short', day: 'numeric' };
    const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true };
    return `${d.toLocaleDateString(undefined, dateOpts)} at ${d.toLocaleTimeString(undefined, timeOpts)}`;
}
