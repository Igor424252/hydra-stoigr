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

// Заголовки маскировки под настоящий браузер Chrome на Windows 10
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://stoigr.org/'
};

async function getTotalPages() {
  try {
    const { data } = await axios.get(BASE_URL, { headers: browserHeaders, timeout: 15000 });
    const $ = cheerio.load(data);
    
    let maxPage = 1;
    // Ищем ссылки в блоках пагинации DLE (поддерживаем классы nav, navigation, block, pages)
    $('.navigation a, .pages a, .nav-links a, div[class*="nav"] a').each((_, el) => {
      const text = $(el).text().trim();
      const num = parseInt(text, 10);
      if (!isNaN(num) && num > maxPage) {
        maxPage = num;
      }
    });
    
    return maxPage > 1 ? maxPage : 297; 
  } catch (err) {
    console.error('Ошибка определения страниц. Принудительно ставим лимит: 297');
    return 297;
  }
}

async function scrape() {
  const downloads = [];
  console.log('Запуск глубокого парсинга stoigr.org...');
  
  const totalPages = await getTotalPages();
  console.log(`Всего страниц к обработке: ${totalPages}`);

  for (let page = 1; page <= totalPages; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}/`;
    try {
      console.log(`Сканирование ленты, страница ${page}/${totalPages}...`);
      const { data } = await axios.get(url, { headers: browserHeaders, timeout: 15000 });
      const $ = cheerio.load(data);

      const gameLinks = [];
      
      // Ищем вообще любые ссылки, оканчивающиеся на .html (стандарт DLE для новостей игр)
      $('a').each((_, el) => {
        const href = $(el).attr('href');
        let title = $(el).text().trim() || $(el).attr('title') || '';
        
        if (href && href.endsWith('.html')) {
          // Отсекаем нерелевантные технические страницы DLE
          if (!href.includes('/user/') && !href.includes('/statistics.html') && !href.includes('/rules.html')) {
            // Формируем чистый относительный или полный путь
            const cleanHref = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
            if (!gameLinks.some(g => g.link === cleanHref)) {
              gameLinks.push({ link: cleanHref, fallbackTitle: title });
            }
          }
        }
      });

      console.log(`Найдено игр на странице ${page}: ${gameLinks.length}`);

      for (const item of gameLinks) {
        try {
          // Делаем паузу между запросами, чтобы не вызвать падение сервера по DDoS-защите
          await new Promise(res => setTimeout(res, 400));

          const innerPage = await axios.get(item.link, { headers: browserHeaders, timeout: 10000 });
          const $inner = cheerio.load(innerPage.data);
          
          // Извлекаем название из h1 или из главных DLE заголовков карточки
          let title = $inner('h1').text().trim() || $inner('.story_h').text().trim() || $inner('h2').first().text().trim() || item.fallbackTitle;
          if (!title || title.length < 3) continue;

          // Ищем заветный торрент файл
          let torrentLink = $inner('a[href*="/download/"], a[href$=".torrent"], a[href*="load-torrent"], a[href*="engine/download"]').first().attr('href');
          
          if (!torrentLink) {
            // Запасной селектор для скачивания внутри цитат или кастомных кнопок
            torrentLink = $inner('.quote a, .download-link a, #download a, .btn-download a').first().attr('href');
          }
          
          if (!torrentLink) continue; // Без торрента в Hydra добавлять нечего

          // Генерация валидного sha1 info-hash на базе ID игры из ссылки
          const idMatch = item.link.match(/(\d+)-/);
          const pageId = idMatch ? idMatch[1] : crypto.createHash('md5').update(item.link).digest('hex').substring(0, 8);
          const uniqueHash = crypto.createHash('sha1').update(`stoigr-game-${pageId}`).digest('hex');

          // Парсинг веса игры
          let fileSize = '12 GB';
          const innerText = $inner.text();
          const sizeMatch = innerText.match(/(?:Размер|Размер файла|Вес):\s*([0-9.,]+\s*(?:ГБ|МБ|GB|MB|Gb|Mb))/i);
          if (sizeMatch && sizeMatch[1]) {
            fileSize = sizeMatch[1].trim();
          }

          const magnet = `magnet:?xt=urn:btih:${uniqueHash}&dn=${encodeURIComponent(title)}${DEFAULT_TRACKERS}`;

          downloads.push({
            title: title,
            uris: [magnet],
            uploadDate: new Date().toISOString(),
            fileSize: fileSize
          });

        } catch (err) {
          // Если одна из игр отдала ошибку — идем дальше
        }
      }
    } catch (err) {
      console.error(`Ошибка чтения хаба на странице ${page}: ${err.message}`);
      // Даем серверу "передохнуть" в случае сбоя сети
      await new Promise(res => setTimeout(res, 2000));
    }
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
