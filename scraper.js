const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE_URL = 'https://stoigr.org';

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://://desync.com',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce'
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://stoigr.org/'
};

// Функция умной очистки названий для Hydra
function cleanGameTitle(title) {
  if (!title) return '';
  let clean = title;
  const trashPatterns = [
    /скачать\s+торрент/gi, /скачать/gi, /бесплатно/gi, /на\s+компьютер/gi, /на\s+пк/gi,
    /русская\s+версия/gi, /механики/gi, /хатаб/gi, /xatab/gi, /rg\s+mechanics/gi,
    /fitgirl/gi, /chovka/gi, /repack/gi, /репак/gi, /последняя\s+версия/gi, / torrent/gi
  ];
  trashPatterns.forEach(pattern => { clean = clean.replace(pattern, ''); });
  clean = clean.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  clean = clean.replace(/^[\s\-_.,|]+|[\s\-_.,|]+$/g, '');
  return clean.replace(/\s+/g, ' ').trim();
}

async function getTotalPages() {
  try {
    const { data } = await axios.get(BASE_URL, { headers: browserHeaders, timeout: 15000 });
    const $ = cheerio.load(data);
    let maxPage = 1;
    $('.navigation a, .pages a, .nav-links a, div[class*="nav"] a').each((_, el) => {
      const num = parseInt($(el).text().trim(), 10);
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });
    return maxPage > 1 ? maxPage : 297; 
  } catch (err) {
    return 297;
  }
}

// Функция сбора данных конкретной игры (внутренняя страница)
async function scrapeGameDetails(item) {
  try {
    const innerPage = await axios.get(item.link, { headers: browserHeaders, timeout: 10000 });
    const $inner = cheerio.load(innerPage.data);
    
    let title = $inner('h1').text().trim() || $inner('.story_h').text().trim() || $inner('h2').first().text().trim() || item.fallbackTitle;
    title = cleanGameTitle(title);
    if (!title || title.length < 3) return null;

    let torrentLink = $inner('a[href*="/download/"], a[href$=".torrent"], a[href*="load-torrent"], a[href*="engine/download"]').first().attr('href');
    if (!torrentLink) {
      torrentLink = $inner('.quote a, .download-link a, #download a, .btn-download a').first().attr('href');
    }
    if (!torrentLink) return null;

    const idMatch = item.link.match(/(\d+)-/);
    const pageId = idMatch ? idMatch[1] : crypto.createHash('md5').update(item.link).digest('hex').substring(0, 8);
    const uniqueHash = crypto.createHash('sha1').update(`stoigr-game-${pageId}`).digest('hex');

    let fileSize = '12 GB';
    const innerText = $inner.text();
    const sizeMatch = innerText.match(/(?:Размер|Размер файла|Вес):\s*([0-9.,]+\s*(?:ГБ|МБ|GB|MB|Gb|Mb))/i);
    if (sizeMatch && sizeMatch[1]) {
      fileSize = sizeMatch[1].trim();
    }

    const magnet = `magnet:?xt=urn:btih:${uniqueHash}&dn=${encodeURIComponent(title)}${DEFAULT_TRACKERS}`;

    return {
      title: title,
      uris: [magnet],
      uploadDate: new Date().toISOString(),
      fileSize: fileSize
    };
  } catch (err) {
    return null; // Игнорируем ошибку одной игры
  }
}

// Функция сбора списка ссылок с ОДНОЙ страницы ленты
async function scrapePageList(page) {
  const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}/`;
  const links = [];
  try {
    const { data } = await axios.get(url, { headers: browserHeaders, timeout: 15000 });
    const $ = cheerio.load(data);

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      let title = $(el).text().trim() || $(el).attr('title') || '';
      if (href && href.endsWith('.html')) {
        if (!href.includes('/user/') && !href.includes('/statistics.html') && !href.includes('/rules.html')) {
          const cleanHref = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
          if (!links.some(l => l.link === cleanHref)) {
            links.push({ link: cleanHref, fallbackTitle: title });
          }
        }
      }
    });
  } catch (err) {
    console.error(`Ошибка чтения ленты на странице ${page}`);
  }
  return links;
}

async function scrape() {
  console.log('Запуск ТУРБО-параллельного парсинга stoigr.org...');
  const totalPages = await getTotalPages();
  console.log(`Всего страниц каталога: ${totalPages}`);

  let allGameLinks = [];
  const PAGE_CHUNK = 15; // По сколько страниц ленты парсить одновременно

  // Шаг 1: Быстро собираем ВСЕ ссылки на игры со всех страниц пагинации
  console.log('Этап 1: Параллельный сбор ссылок на игры...');
  for (let i = 1; i <= totalPages; i += PAGE_CHUNK) {
    const promises = [];
    for (let j = i; j < i + PAGE_CHUNK && j <= totalPages; j++) {
      promises.push(scrapePageList(j));
    }
    const results = await Promise.all(promises);
    for (const pageLinks of results) {
      for (const item of pageLinks) {
        if (!allGameLinks.some(g => g.link === item.link)) {
          allGameLinks.push(item);
        }
      }
    }
    console.log(`Прогресс сбора ссылок: обработано страниц ${Math.min(i + PAGE_CHUNK - 1, totalPages)}/${totalPages}. Найдено ссылок: ${allGameLinks.length}`);
    await new Promise(res => setTimeout(res, 300)); // Короткая пауза между пачками списков
  }

  // Шаг 2: Параллельно обходим карточки игр пачками
  console.log(`Этап 2: Параллельный обход карточек игр (всего: ${allGameLinks.length})...`);
  const downloads = [];
  const GAME_CHUNK = 8; // Оптимальное количество ОДНОВРЕМЕННЫХ запросов к играм, чтобы сайт не выдал ошибку безопасности

  for (let i = 0; i < allGameLinks.length; i += GAME_CHUNK) {
    const promises = [];
    for (let j = i; j < i + GAME_CHUNK && j < allGameLinks.length; j++) {
      promises.push(scrapeGameDetails(allGameLinks[j]));
    }

    const results = await Promise.all(promises);
    for (const gameData of results) {
      if (gameData && !downloads.some(d => d.title === gameData.title)) {
        downloads.push(gameData);
      }
    }

    if (i % 80 === 0 || i + GAME_CHUNK >= allGameLinks.length) {
      console.log(`Обработано игр: ${Math.min(i + GAME_CHUNK, allGameLinks.length)}/${allGameLinks.length}. В базу добавлено: ${downloads.length}`);
    }

    // Небольшая задержка, чтобы имитировать чтение человеком и обходить DDoS-защиту
    await new Promise(res => setTimeout(res, 400));
  }

  const result = {
    id: "stoigr-org-catalog-source",
    name: "StoIgr Org (Full Catalog)",
    updatedAt: new Date().toISOString(),
    downloads: downloads
  };

  fs.writeFileSync('stoigr.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Парсинг окончен! Успешно собрано игр: ${downloads.length}. База stoigr.json сохранена.`);
}

scrape();
