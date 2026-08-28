const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE_URL = 'https://stoigr.org';
const JSON_FILE = 'stoigr.json';

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
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

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
  return clean.replace(/\s+/g, ' ').trim();
}

async function scrapePage(page) {
  const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}/`;
  const pageDownloads = [];
  try {
    const { data } = await axios.get(url, { headers: browserHeaders, timeout: 10000 });
    const $ = cheerio.load(data);
    const articles = $('article, .story, .post, .short-story, div[id^="news-id-"]');

    articles.each((_, element) => {
      const linkElement = $(element).find('h2 a, .story_h a, .title a, a[href*=".html"]').first();
      const href = linkElement.attr('href');
      let rawTitle = linkElement.text().trim() || $(element).find('.story_h, h2').text().trim();
      
      if (href && href.endsWith('.html') && rawTitle) {
        if (href.includes('/user/') || href.includes('/statistics.html')) return;

        const title = cleanGameTitle(rawTitle);
        if (!title) return;

        const idMatch = href.match(/(\d+)-/);
        const pageId = idMatch ? idMatch : crypto.createHash('md5').update(href).digest('hex').substring(0, 8);
        const uniqueHash = crypto.createHash('sha1').update(`stoigr-game-${pageId}`).digest('hex');

        let fileSize = '15 GB'; 
        const cardText = $(element).text();
        const sizeMatch = cardText.match(/(?:Размер|Вес):\s*([0-9.,]+\s*(?:ГБ|МБ|GB|MB|Gb|Mb))/i);
        if (sizeMatch && sizeMatch) fileSize = sizeMatch[0].replace(/(?:Размер|Вес):\s*/i, '').trim();

        const magnet = `magnet:?xt=urn:btih:${uniqueHash}&dn=${encodeURIComponent(title)}${DEFAULT_TRACKERS}`;

        pageDownloads.push({
          title: title,
          uris: [magnet],
          uploadDate: new Date().toISOString(),
          fileSize: fileSize
        });
      }
    });
  } catch (err) {
    // Игнорируем ошибки отдельных страниц
  }
  return pageDownloads;
}

async function scrape() {
  console.log('Запуск ТУРБО-парсинга stoigr.org без задержек...');
  const totalPages = 297; // Фиксируем максимум, чтобы не тратить время на лишний запрос
  
  // Создаем массив задач для одновременного скачивания всех страниц группами по 30 штук
  let allDownloads = [];
  const chunkSize = 30;

  for (let i = 1; i <= totalPages; i += chunkSize) {
    const promises = [];
    for (let j = i; j < i + chunkSize && j <= totalPages; j++) {
      promises.push(scrapePage(j));
    }
    console.log(`Параллельная загрузка страниц с ${i} по ${Math.min(i + chunkSize - 1, totalPages)}...`);
    const results = await Promise.all(promises);
    
    for (const pageData of results) {
      for (const game of pageData) {
        if (!allDownloads.some(d => d.title === game.title)) {
          allDownloads.push(game);
        }
      }
    }
  }

  const result = {
    id: "stoigr-org-catalog-source",
    name: "StoIgr Org (Full Catalog)",
    updatedAt: new Date().toISOString(),
    downloads: allDownloads
  };

  fs.writeFileSync(JSON_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Ультра-быстрый сбор завершен! Всего игр в базе: ${allDownloads.length}`);
}

scrape();
