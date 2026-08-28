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

async function getTotalPages() {
  try {
    const { data } = await axios.get(BASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const $ = cheerio.load(data);
    
    // Ищем пагинацию внизу страницы
    const links = $('.navigation a, .pages a, .nav-links a');
    let maxPage = 1;
    
    links.each((_, el) => {
      const text = $(el).text().trim();
      const num = parseInt(text, 10);
      if (!isNaN(num) && num > maxPage) {
        maxPage = num;
      }
    });
    
    return maxPage > 1 ? maxPage : 100;
  } catch (err) {
    console.error('Ошибка определения страниц, ставим 100 по умолчанию');
    return 100;
  }
}

async function scrape() {
  const downloads = [];
  console.log('Запуск обновленного парсинга сайта stoigr.org...');
  
  const totalPages = await getTotalPages();
  console.log(`Всего страниц для обхода: ${totalPages}`);

  for (let page = 1; page <= totalPages; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}/`;
    try {
      console.log(`Сканирование страницы ${page} из ${totalPages}...`);
      const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 15000 });
      const $ = cheerio.load(data);

      // Собираем абсолютно все ссылки на странице, которые ведут на отдельные игры (.html)
      const gameLinks = [];
      $('a[href*="/html"]').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).text().trim() || $(el).find('img').attr('alt') || '';
        
        if (href && href.includes('.html') && !gameLinks.some(g => g.link === href)) {
          // Исключаем системные ссылки (профиль, правила и т.д.), если они есть
          if (!href.includes('/user/') && !href.includes('/statistics.html')) {
            gameLinks.push({ link: href, fallbackTitle: title.trim() });
          }
        }
      });

      console.log(`Найдено потенциальных игр на странице ${page}: ${gameLinks.length}`);

      for (const item of gameLinks) {
        try {
          let fullLink = item.link.startsWith('http') ? item.link : `${BASE_URL}${item.link}`;
          
          const innerPage = await axios.get(fullLink, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 10000 });
          const $inner = cheerio.load(innerPage.data);
          
          // Определяем точное название игры со страницы материала
          let title = $inner('h1').text().trim() || $inner('.story_h, .title, h2').first().text().trim() || item.fallbackTitle;
          if (!title) continue;

          // Ищем ссылку на скачивание торрента
          // Проверяем разные варианты: ссылки с /download/, файлы .torrent или кнопки загрузки
          let torrentLinkAttr = $inner('a[href*="/download/"], a[href$=".torrent"], a[href*="load-torrent"]').first().attr('href');
          
          if (!torrentLinkAttr) {
            // Если явной ссылки нет, ищем любую ссылку внутри блока скачивания
            torrentLinkAttr = $inner('.download-link a, .quote a, #download a').first().attr('href');
          }
          
          if (!torrentLinkAttr) continue; // Если торрент не найден, пропускаем страницу
          
          // Извлекаем ID публикации для создания уникального хэша magnet-ссылки
          const pageIdMatch = fullLink.match(/(\d+)-/);
          const pageId = pageIdMatch ? pageIdMatch[1] : Buffer.from(fullLink).toString('base64').substring(0, 10);
          const uniqueHash = crypto.createHash('sha1').update(`stoigr-id-${pageId}`).digest('hex');

          // Пытаемся найти размер файла на странице
          let fileSize = '15 GB'; 
          const pageText = $inner.text();
          const sizeMatch = pageText.match(/(?:Размер|Размер файла|Вес):\s*([0-9.,]+\s*(?:ГБ|МБ|GB|MB|Gb|Mb))/i);
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
          // Игнорируем мелкие ошибки отдельных страниц, чтобы скрипт не падал полностью
        }
        
        // Пауза 250мс между играми
        await new Promise(res => setTimeout(res, 250));
      }
    } catch (err) {
      console.error(`Ошибка при чтении страницы списка ${page}: ${err.message}`);
    }
  }

  const result = {
    id: "stoigr-org-catalog-source",
    name: "StoIgr Org (Full Catalog)",
    updatedAt: new Date().toISOString(),
    downloads: downloads
  };

  fs.writeFileSync('stoigr.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Успешно! Собрано игр: ${downloads.length}. Файл stoigr.json записан.`);
}

scrape();
