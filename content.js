// Content script to detect and block suspicious cookies
console.log('Cookie Privacy Guard content script loaded');

let suspiciousCookies = [];

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SUSPICIOUS_COOKIE') {
    handleSuspiciousCookie(message.cookie, message.riskScore);
  }
  return true;
});

function handleSuspiciousCookie(cookie, riskScore) {
  // Check if we already have this cookie
  const existingIndex = suspiciousCookies.findIndex(
    c => c.name === cookie.name && c.domain === cookie.domain
  );
  
  if (existingIndex === -1) {
    const analyzedCookie = analyzeCookieData(cookie);
    analyzedCookie.riskScore = riskScore;
    analyzedCookie.timestamp = new Date().toISOString();
    
    suspiciousCookies.push(analyzedCookie);
    
    // Only show warning for medium/high risk cookies
    if (riskScore >= 2) {
      showCookieWarning(analyzedCookie);
    }
    
    console.log('Suspicious cookie analyzed:', analyzedCookie);
  }
}

function analyzeCookieData(cookie) {
  const potentialData = detectPotentialData(cookie);
  const riskLevel = getRiskLevel(potentialData.length, cookie);
  
  return {
    ...cookie,
    potentialData: potentialData,
    riskLevel: riskLevel
  };
}

function detectPotentialData(cookie) {
  const dataTypes = [];
  const cookieStr = (cookie.name + '=' + cookie.value).toLowerCase();
  
  // Data type patterns
  const dataPatterns = {
    'email': ['email', 'mail', '@'],
    'name': ['name', 'user', 'username', 'fullname', 'firstname', 'lastname'],
    'location': ['location', 'geo', 'lat', 'long', 'gps', 'address', 'city', 'country', 'zip'],
    'device_info': ['device', 'os', 'browser', 'platform', 'useragent', 'screen', 'resolution', 'mobile'],
    'ip_address': ['ip', 'address', 'remoteaddr', 'clientip'],
    'browsing_behavior': ['behavior', 'click', 'scroll', 'movement', 'activity', 'history', 'visit'],
    'preferences': ['preference', 'setting', 'config', 'theme', 'language', 'currency'],
    'session_data': ['session', 'login', 'token', 'auth', 'password', 'credential'],
    'marketing_data': ['ad', 'marketing', 'campaign', 'tracking', 'analytics', 'conversion'],
    'social_media_data': ['social', 'facebook', 'twitter', 'linkedin', 'instagram', 'google', 'youtube'],
    'shopping_data': ['cart', 'basket', 'purchase', 'product', 'item', 'price'],
    'demographic_data': ['age', 'gender', 'birth', 'income', 'education']
  };
  
  for (const [dataType, patterns] of Object.entries(dataPatterns)) {
    if (patterns.some(pattern => cookieStr.includes(pattern))) {
      dataTypes.push(dataType);
    }
  }
  
  return [...new Set(dataTypes)]; // Remove duplicates
}

function getRiskLevel(dataTypesCount, cookie) {
  if (dataTypesCount >= 3) {
    return 'high';
  } else if (dataTypesCount >= 1) {
    return 'medium';
  }
  return 'low';
}

function showCookieWarning(cookie) {
  // Check if notification already exists
  if (document.getElementById('cookie-privacy-notification')) {
    return;
  }
  
  // Create notification
  const notification = document.createElement('div');
  notification.id = 'cookie-privacy-notification';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 8px;
    padding: 15px;
    max-width: 350px;
    z-index: 10000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-family: Arial, sans-serif;
    font-size: 14px;
    color: #856404;
  `;
  
  const riskColors = {
    'high': '#dc3545',
    'medium': '#fd7e14', 
    'low': '#198754'
  };
  
  notification.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
      <span style="color: ${riskColors[cookie.riskLevel]}; font-size: 16px;">⚠️</span>
      Suspicious Cookie Detected
    </div>
    <div style="font-size: 12px; margin-bottom: 10px; line-height: 1.4;">
      <strong style="color: #333;">${cookie.name}</strong> may be collecting: 
      <br>
      <span style="color: #666;">${cookie.potentialData.join(', ') || 'Various data types'}</span>
      <br><br>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span>Risk Level: 
          <strong style="color: ${riskColors[cookie.riskLevel]}">
            ${cookie.riskLevel.toUpperCase()}
          </strong>
        </span>
        <span style="font-size: 10px; color: #999;">Domain: ${cookie.domain}</span>
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button id="manage-cookie-btn" style="background: #007bff; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; flex: 2;">
        🛡️ Manage Cookies
      </button>
      <button id="close-notification-btn" style="background: #6c757d; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
        Dismiss
      </button>
    </div>
  `;
  
  document.body.appendChild(notification);
  
  // Add event listeners
  document.getElementById('manage-cookie-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    notification.remove();
  });
  
  document.getElementById('close-notification-btn').addEventListener('click', () => {
    notification.remove();
  });
  
  // Auto-remove after 15 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.remove();
    }
  }, 15000);
}

// Make suspiciousCookies available to popup via background script
function getSuspiciousCookies() {
  return suspiciousCookies;
}

// Scan existing cookies when content script loads
setTimeout(() => {
  chrome.runtime.sendMessage({ 
    type: 'CONTENT_SCRIPT_LOADED',
    url: window.location.href 
  });
}, 1000);

// Export functions for popup access
window.cookiePrivacyGuard = {
  getSuspiciousCookies: getSuspiciousCookies,
  analyzeCookieData: analyzeCookieData
};