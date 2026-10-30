const API_BASE_URL = 'https://loans-1uwj.onrender.com';

function showAlert(elementId, message, isError = false) {
  const alertEl = document.getElementById(elementId);
  if (!alertEl) return;
  alertEl.textContent = message;
  alertEl.className = `alert ${isError ? 'alert-error' : 'alert-success'}`;
  alertEl.style.display = 'block';
}