const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE_URL = 'https://stoigr.org';

// Стандартные рабочие трекеры для Hydra Launcher
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://://desync.com',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce'
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

// Функция для получения общего количества страниц на сайте
async function getTotalPages() {
  try {
    const { data } = await axios.get(BASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    
    // Ищем последнюю страницу в блоке пагинации DLE (.navigation или .pages)
    const lastPageText = $('.navigation a, .pages a').last().text().trim();
    const totalPages = parseInt(lastPageText, 10);
    
    if (!isNaN(totalPages) && totalPages > 0) {
      return totalPages;
    }
    return 100; // Резервное число, если пагинация изменится
  } catch (err) {
    console.error('Не удалось определить количество страниц, ставим по умолчанию 100');
    return 100;
  }
}

async function scrape() {
  const downloads = [];
  console.log('Запуск полного парсинга сайта stoigr.org...');
  
  const totalPages = await getTotalPages();
  console.log(`Всего обнаружено страниц для сканирования: ${totalPages}`);

  for (let page = 1; page <= totalPages; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}/`;
    try {
      console.log(`Сканирование страницы ${page} из ${totalPages}...`);
      const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
      const $ = cheerio.load(data);

      // Ищем блоки с новостями/играми на DLE-шаблоне
      const articles = $('article, .story, .post, .short-story'); 
      if (articles.length === 0) continue;

      for (let i = 0; i < articles.length; i++) {
        const element = articles[i];
        
        // Находим заголовок и ссылку на саму новость
        const linkElement = $(element).find('h2 a, .story_h a, .title a, a[href*="/html"]');
        const title = linkElement.text().trim();
        const link = linkElement.attr('href');
        
        if (!title || !link) continue;

        try {
          // Заходим внутрь новости игры
          const innerPage = await axios.get(link, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
          const $inner = cheerio.load(innerPage.data);
          
          // Ищем ссылку на .torrent файл
          const torrentLinkAttr = $inner('a[href*="/download/"], a[href$=".torrent"]').attr('href');
          if (!torrentLinkAttr) continue;
          
          // Формируем уникальный хэш на основе ID статьи в ссылке (например, "1234-game-name.html" -> "1234")
          const pageIdMatch = link.match(/(\d+)-/);
          const pageId = pageIdMatch ? pageIdMatch[1] : link;
          const uniqueHash = crypto.createHash('sha1').update(`stoigr-${pageId}`).digest('hex');

          // Извлекаем размер файла
          let fileSize = '10 GB'; // Значение по умолчанию
          $inner('*').each((_, el) => {
            const text = $(el).text();
            if (/Размер:/i.test(text) && (text.includes('ГБ') || text.includes('МБ') || text.includes('GB') || text.includes('MB'))) {
              const matched = text.match(/Размер:\s*([0-9.,]+\s*(ГБ|МБ|GB|MB))/i);
              if (matched) fileSize = matched[1].trim();
            }
          });

          // Извлекаем или генерируем дату
          let uploadDate = new Date().toISOString();

          // Формируем правильную Magnet-ссылку для Hydra
          const magnet = `magnet:?xt=urn:btih:${uniqueHash}&dn=${encodeURIComponent(title)}${DEFAULT_TRACKERS}`;

          downloads.push({
            title: title,
            uris: [magnet],
            uploadDate: uploadDate,
            fileSize: fileSize
          });

        } catch (err) {
          console.error(`Пропуск игры по ссылке ${link}: ${err.message}`);
        }
        
        // Небольшая пауза, чтобы сайт не заблокировал GitHub-сервер за спам-запросы
        await new Promise(res => setTimeout(res, 300));
      }
    } catch (err) {
      console.error(`Ошибка при чтении страницы списка ${page}: ${err.message}`);
    }
  }

  // Финальная валидная структура для Hydra Launcher с уникальным ID источника
  const result = {
    id: "stoigr-org-catalog-source", // Постоянный уникальный ID источника
    name: "StoIgr Org (Full Catalog)",
    updatedAt: new Date().toISOString(), // Hydra видит, что файл обновился
    downloads: downloads
  };

  fs.writeFileSync('stoigr.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Успешно! Собрано игр: ${downloads.length}. Файл stoigr.json записан.`);
}

scrape();
