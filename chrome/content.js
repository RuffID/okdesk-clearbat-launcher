(function () {
  const LAUNCH_BUTTON_CLASS = 'okdesk-clearbat-launch-button';
  const INFO_BUTTON_CLASS = 'okdesk-clearbat-info-button';
  const ACCESS_VALUE_SEPARATOR = '/';
  const IIKO_CREDENTIALS_PARAMETER_CODE = '0008';
  const WEB_LINK_PARAMETER_CODE = '1212';
  const INVALID_PLACEHOLDER_VALUES = new Set(['-', 'неуказано', '[неуказано]']);
  const ACCESS_BUTTONS = [
    { parameterCode: 'AnyDesk', clearbatType: 'anydesk', displayName: 'AnyDesk', iconFile: 'anydesk.png', requirePassword: true },
    { parameterCode: 'AA', clearbatType: 'ammyy', displayName: 'АмиАдмин', iconFile: 'ammyadmin.png', requirePassword: false },
    { parameterCode: 'AC', clearbatType: 'assistant', displayName: 'Ассистент', iconFile: 'assistant.png', requirePassword: false },
    { parameterCode: 'rust', clearbatType: 'rustdesk', displayName: 'RustDesk', iconFile: 'rustdesk.ico', requirePassword: false }
  ];
  const SERVER_ACCESS_BUTTONS = [
    { parameterCode: 'srv_addr', displayName: 'RMS', iconFile: 'iikoOffice_icon.ico' },
    { parameterCode: '0017', displayName: 'Chain', iconFile: 'iikoChain_icon.ico' }
  ];
  let scanScheduled = false;

  function scheduleScanAccessParameters() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    window.requestAnimationFrame(function () {
      scanScheduled = false;
      scanAccessParameters();
    });
  }

  function scanAccessParameters() {
    for (const accessButton of ACCESS_BUTTONS) {
      const items = document.querySelectorAll(`[data-role^="equipment-parameter-${accessButton.parameterCode}-"]`);

      for (const item of items) {
        addLaunchButton(item, accessButton);
      }
    }

    for (const accessButton of SERVER_ACCESS_BUTTONS) {
      const items = document.querySelectorAll(`[data-role^="equipment-parameter-${accessButton.parameterCode}-"]`);

      for (const item of items) {
        addServerLaunchButton(item);
      }
    }

    const webLinkItems = document.querySelectorAll(`[data-role^="equipment-parameter-${WEB_LINK_PARAMETER_CODE}-"]`);
    for (const item of webLinkItems) {
      makeWebLinkClickable(item);
    }
  }

  function addLaunchButton(item, accessButton) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    const labelElement = item.querySelector('dt');
    if (!valueElement) {
      return;
    }

    const credentials = parseAccessCredentials(valueElement.textContent, accessButton.requirePassword);
    if (credentials === null) {
      upsertLaunchControls(item, labelElement, valueElement, {
        clearbatUrl: '',
        displayName: accessButton.displayName,
        iconFile: accessButton.iconFile,
        isReady: false,
        message: getTerminalInvalidMessage(accessButton)
      });
      return;
    }

    upsertLaunchControls(item, labelElement, valueElement, {
      clearbatUrl: buildClearbatUrl(accessButton.clearbatType, credentials),
      displayName: accessButton.displayName,
      iconFile: accessButton.iconFile,
      isReady: true,
      message: getReadyMessage(accessButton.displayName)
    });
  }

  function addServerLaunchButton(item) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    const labelElement = item.querySelector('dt');
    if (!valueElement) {
      return;
    }

    const scope = item.closest('.custom-parameters-list') || document;
    const iikoCredentialsElement = scope.querySelector(`[data-role^="equipment-parameter-${IIKO_CREDENTIALS_PARAMETER_CODE}-"] [data-role="bip-value"]`);
    const iikoCredentials = parseAccessCredentials(iikoCredentialsElement ? iikoCredentialsElement.textContent : '', false);
    const serverAccess = parseServerAccess(valueElement.textContent);
    if (iikoCredentials === null || serverAccess === null) {
      upsertLaunchControls(item, labelElement, valueElement, {
        clearbatUrl: '',
        displayName: getServerDisplayName(item),
        iconFile: getServerIconFile(item),
        isReady: false,
        message: getServerInvalidMessage(iikoCredentials, serverAccess)
      });
      return;
    }

    const clearbatUrl = buildIikoClearbatUrl(serverAccess.address, {
      login: iikoCredentials.login,
      password: serverAccess.password || iikoCredentials.password
    });

    upsertLaunchControls(item, labelElement, valueElement, {
      clearbatUrl,
      displayName: getServerDisplayName(item),
      iconFile: getServerIconFile(item),
      isReady: true,
      message: getServerReadyMessage(getServerDisplayName(item))
    });
  }

  function upsertLaunchControls(item, labelElement, valueElement, options) {
    let button = item.querySelector(`.${LAUNCH_BUTTON_CLASS}`);
    if (!button) {
      button = createLaunchButton();
      appendControl(labelElement, valueElement, button);
    }

    updateLaunchButton(button, options);

    let infoButton = item.querySelector(`.${INFO_BUTTON_CLASS}`);
    if (!infoButton) {
      infoButton = createInfoButton();
      button.insertAdjacentElement('afterend', infoButton);
    }

    infoButton.title = options.message;
    infoButton.setAttribute('aria-label', options.message);
  }

  function appendControl(labelElement, valueElement, control) {
    if (labelElement) {
      labelElement.appendChild(control);
      return;
    }

    valueElement.insertAdjacentElement('afterend', control);
  }

  function createLaunchButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = LAUNCH_BUTTON_CLASS;
    button.style.cssText = [
      'margin-left: 8px',
      'padding: 0',
      'border: 1px solid transparent',
      'border-radius: 4px',
      'width: 26px',
      'height: 26px',
      'min-width: 26px',
      'min-height: 26px',
      'cursor: pointer',
      'vertical-align: middle',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'overflow: hidden'
    ].join(';');

    button.addEventListener('mouseenter', function () {
      applyLaunchButtonInteractiveState(button, true);
    });
    button.addEventListener('mouseleave', function () {
      applyLaunchButtonInteractiveState(button, false);
    });
    button.addEventListener('focus', function () {
      applyLaunchButtonInteractiveState(button, true);
    });
    button.addEventListener('blur', function () {
      applyLaunchButtonInteractiveState(button, false);
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (!button.dataset.clearbatUrl) {
        return;
      }

      window.location.assign(button.dataset.clearbatUrl);
    });

    return button;
  }

  function updateLaunchButton(button, options) {
    button.title = options.isReady
      ? `Запустить ${options.displayName}`
      : options.message;
    button.setAttribute('aria-label', button.title);
    button.dataset.isReady = options.isReady ? 'true' : 'false';
    button.style.cursor = options.isReady ? 'pointer' : 'default';
    applyLaunchButtonInteractiveState(button, false);
    setClearbatUrl(button, options.clearbatUrl);

    let icon = button.querySelector('img');
    if (!icon) {
      icon = document.createElement('img');
      icon.style.cssText = [
        'display: block',
        'width: 100%',
        'height: 100%',
        'object-fit: contain',
        'box-sizing: border-box',
        'padding: 2px'
      ].join(';');
      button.appendChild(icon);
    }

    icon.src = chrome.runtime.getURL(`icons/${options.iconFile}`);
    icon.alt = options.displayName;
    icon.style.opacity = options.isReady ? '1' : '0.55';
    icon.style.filter = options.isReady ? '' : 'grayscale(1)';
  }

  function applyLaunchButtonInteractiveState(button, isActive) {
    if (button.dataset.isReady === 'true') {
      button.style.borderColor = isActive ? '#2f80ed' : 'transparent';
      button.style.background = 'transparent';
      return;
    }

    button.style.borderColor = isActive ? '#d93025' : '#b8bec7';
    button.style.background = isActive ? '#d93025' : '#f1f3f4';
  }

  function createInfoButton() {
    const infoButton = document.createElement('span');
    infoButton.className = INFO_BUTTON_CLASS;
    infoButton.textContent = '?';
    infoButton.tabIndex = 0;
    infoButton.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'width: 14px',
      'height: 14px',
      'margin-left: 4px',
      'border: 1px solid #8a8f98',
      'border-radius: 50%',
      'color: #555f6d',
      'background: #ffffff',
      'font: 10px Arial, sans-serif',
      'line-height: 14px',
      'cursor: help',
      'vertical-align: super'
    ].join(';');

    return infoButton;
  }

  function setClearbatUrl(button, clearbatUrl) {
    if (button.dataset.clearbatUrl === clearbatUrl) {
      return;
    }

    button.dataset.clearbatUrl = clearbatUrl;
  }

  function getTerminalInvalidMessage(accessButton) {
    if (accessButton.requirePassword) {
      return `Заполните поле ${accessButton.displayName} в формате: идентификатор / пароль. Также на ПК должен быть установлен и настроен CLEAR.bat для обработки ссылок clearbat.`;
    }

    return `Заполните поле ${accessButton.displayName}. Допустимый формат: идентификатор или идентификатор / пароль. Также на ПК должен быть установлен и настроен CLEAR.bat для обработки ссылок clearbat.`;
  }

  function getServerInvalidMessage(iikoCredentials, serverAccess) {
    if (iikoCredentials === null && serverAccess === null) {
      return 'Заполните адрес сервера и поле Iiko логин/пароль. Адрес указывается в формате host или host:port, а поле Iiko логин/пароль обязательно для запуска обычного сервера и iikoChain через CLEAR.bat.';
    }

    if (serverAccess === null) {
      return 'Заполните поле Адрес сервера в формате host или host:port. Для запуска также обязательно должно быть заполнено поле Iiko логин/пароль в формате login / password, а на ПК должен быть установлен и настроен CLEAR.bat.';
    }

    return 'Заполните поле Iiko логин/пароль в формате login / password. Эти данные обязательны для запуска подключения к серверу или iikoChain через CLEAR.bat.';
  }

  function getReadyMessage(displayName) {
    return `Кнопка запускает ${displayName} через ссылку clearbat. На ПК должен быть установлен и настроен CLEAR.bat, а браузер должен разрешить открытие внешнего приложения.`;
  }

  function getServerReadyMessage(displayName) {
    return `Кнопка запускает ${displayName} через ссылку clearbat. Для запуска используется поле Iiko логин/пароль, оно должно быть заполнено в формате login / password. На ПК должен быть установлен и настроен CLEAR.bat, а браузер должен разрешить открытие внешнего приложения.`;
  }

  function getServerDisplayName(item) {
    return getParameterCode(item) === '0017' ? 'Chain' : 'RMS';
  }

  function getServerIconFile(item) {
    return getParameterCode(item) === '0017' ? 'iikoChain_icon.ico' : 'iikoOffice_icon.ico';
  }

  function getParameterCode(item) {
    const role = item.getAttribute('data-role') || '';
    const prefix = 'equipment-parameter-';
    if (!role.startsWith(prefix)) {
      return '';
    }

    const withoutPrefix = role.slice(prefix.length);
    const lastSeparatorIndex = withoutPrefix.lastIndexOf('-');
    return lastSeparatorIndex < 0 ? withoutPrefix : withoutPrefix.slice(0, lastSeparatorIndex);
  }

  function parseAccessCredentials(value, requirePassword) {
    const normalizedValue = String(value || '').replace(/\s+/g, '');
    if (!normalizedValue || INVALID_PLACEHOLDER_VALUES.has(normalizedValue.toLowerCase())) {
      return null;
    }

    const separatorIndex = normalizedValue.search(/[\/\\]/);
    if (separatorIndex < 0) {
      return requirePassword
        ? null
        : {
          login: normalizedValue,
          password: ''
        };
    }

    const login = normalizedValue.slice(0, separatorIndex);
    const password = normalizedValue.slice(separatorIndex + 1);
    if (login.length === 0) {
      return null;
    }

    if (requirePassword && password.length === 0) {
      return null;
    }

    return {
      login,
      password
    };
  }

  function buildClearbatUrl(clearbatType, credentials) {
    const payloadParts = [
      `?type=${clearbatType}`,
      `?login=${credentials.login}`
    ];

    if (credentials.password) {
      payloadParts.push(`?password=${credentials.password}`);
    }

    return `clearbat:/${toBase64Utf8(payloadParts.join(''))}?encode=full`;
  }

  function buildIikoClearbatUrl(address, credentials) {
    const payloadParts = [
      '?type=iiko',
      `?url=${address}`
    ];

    if (credentials.login) {
      payloadParts.push(`?login=${credentials.login}`);
    }

    if (credentials.password) {
      payloadParts.push(`?password=${credentials.password}`);
    }

    return `clearbat:/${toBase64Utf8(payloadParts.join(''))}?encode=full`;
  }

  function parseServerAccess(value) {
    const normalizedValue = String(value || '').trim();
    if (!isMeaningfulAccessValue(normalizedValue) || /\s/.test(normalizedValue)) {
      return null;
    }

    const parsedValue = splitServerAccessValue(normalizedValue);
    if (parsedValue === null || !isMeaningfulAccessValue(parsedValue.address)) {
      return null;
    }

    const address = ensureServerPort(parsedValue.address);
    if (!address) {
      return null;
    }

    return {
      address,
      password: parsedValue.password
    };
  }

  function splitServerAccessValue(value) {
    const protocolMatch = value.match(/^https?:\/\//i);
    const searchStartIndex = protocolMatch !== null ? protocolMatch[0].length : 0;
    const separatorIndex = value.indexOf(ACCESS_VALUE_SEPARATOR, searchStartIndex);
    if (separatorIndex < 0) {
      return {
        address: value,
        password: ''
      };
    }

    const address = value.slice(0, separatorIndex);
    const password = value.slice(separatorIndex + ACCESS_VALUE_SEPARATOR.length);
    if (!address || !password) {
      return null;
    }

    return {
      address,
      password
    };
  }

  function ensureServerPort(address) {
    const normalizedAddress = String(address || '').trim();
    if (!isMeaningfulAccessValue(normalizedAddress) || /\s/.test(normalizedAddress)) {
      return '';
    }

    if (/^https?:\/\//i.test(normalizedAddress)) {
      try {
        const url = new URL(normalizedAddress);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
          return '';
        }

        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
          return '';
        }

        if (url.port) {
          return url.toString().replace(/\/$/, '');
        }

        url.port = '443';
        return url.toString().replace(/\/$/, '');
      } catch {
        return '';
      }
    }

    if (normalizedAddress.includes('://') || normalizedAddress.includes('?') || normalizedAddress.includes('#')) {
      return '';
    }

    if (hasExplicitPort(normalizedAddress)) {
      return normalizedAddress;
    }

    return `${normalizedAddress}:443`;
  }

  function hasExplicitPort(address) {
    if (!address) {
      return false;
    }

    const lastColonIndex = address.lastIndexOf(':');
    if (lastColonIndex < 0 || lastColonIndex === address.length - 1) {
      return false;
    }

    return /^\d+$/.test(address.slice(lastColonIndex + 1));
  }

  function makeWebLinkClickable(item) {
    const valueElement = item.querySelector('[data-role="bip-value"]');
    if (!valueElement) {
      return;
    }

    const linkUrl = normalizeEquipmentWebLink(valueElement.textContent);
    const existingLink = valueElement.querySelector('a[data-okdesk-clearbat-web-link="true"]');
    if (!linkUrl) {
      if (existingLink) {
        existingLink.replaceWith(document.createTextNode(existingLink.textContent));
      }

      return;
    }

    if (existingLink) {
      if (existingLink.href !== linkUrl) {
        existingLink.href = linkUrl;
      }

      if (existingLink.textContent !== linkUrl) {
        existingLink.textContent = linkUrl;
      }

      return;
    }

    valueElement.textContent = '';

    const link = document.createElement('a');
    link.href = linkUrl;
    link.textContent = linkUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.dataset.okdeskClearbatWebLink = 'true';
    link.addEventListener('click', function (event) {
      event.stopPropagation();
    });
    valueElement.appendChild(link);
  }

  function normalizeEquipmentWebLink(value) {
    const normalizedValue = String(value || '').trim();
    if (!isMeaningfulAccessValue(normalizedValue) || /[\u0400-\u04FF]/u.test(normalizedValue) || /\s/.test(normalizedValue)) {
      return '';
    }

    const urlValue = /^https?:\/\//i.test(normalizedValue)
      ? normalizedValue
      : `https://${normalizedValue}`;

    try {
      const url = new URL(urlValue);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || /[^\x00-\x7F]/.test(url.hostname)) {
        return '';
      }

      return url.toString();
    } catch {
      return '';
    }
  }

  function isMeaningfulAccessValue(value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return false;
    }

    return !INVALID_PLACEHOLDER_VALUES.has(normalizedValue.replace(/\s+/g, '').toLowerCase());
  }

  function toBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return window.btoa(binary);
  }

  scanAccessParameters();

  const observer = new MutationObserver(scheduleScanAccessParameters);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}());
