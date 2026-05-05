(function () {
  var btn = document.getElementById('theme-toggle');
  var icon = document.getElementById('theme-icon');
  var html = document.documentElement;

  function isDark() {
    return html.classList.contains('dark');
  }

  function setIcon() {
    // show the opposite action: if dark now, clicking goes light (show sun); if light, show moon
    icon.textContent = isDark() ? '☀' : '☾';
  }

  // Set initial icon state
  setIcon();

  btn.addEventListener('click', function () {
    if (isDark()) {
      html.classList.remove('dark');
      html.classList.add('light');
      localStorage.setItem('theme', 'light');
    } else {
      html.classList.remove('light');
      html.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    }
    setIcon();
  });
})();
