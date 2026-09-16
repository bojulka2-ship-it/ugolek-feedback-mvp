const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = path.join(__dirname, 'reviews.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_MENU = 100;
const MAX_COMMENT = 500;
const MAX_BODY = 16 * 1024;
const TOO_LARGE = Symbol('tooLarge');
const MIN_REPEAT_LEN = 8;
const MAX_REPEAT_RATIO = 0.7;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  if (rateBuckets.size >= 500) {
    for (const [key, bucket] of rateBuckets) {
      if (now >= bucket.resetAt) rateBuckets.delete(key);
    }
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

function isRepetitive(text) {
  const chars = String(text).replace(/\s+/g, '');
  if (chars.length < MIN_REPEAT_LEN) return false;
  const counts = Object.create(null);
  let max = 0;
  for (const ch of chars.toLowerCase()) {
    counts[ch] = (counts[ch] || 0) + 1;
    if (counts[ch] > max) max = counts[ch];
  }
  return max / chars.length >= MAX_REPEAT_RATIO;
}

const RU_VOWELS = 'аеёиоуыэюя';
const EN_VOWELS = 'aeiouy';

function isJunkyWordText(text) {
  const words = String(text).split(/\s+/);
  for (const word of words) {
    if (word.length < 4) continue;
    const letters = Array.from(word).filter((ch) => /[a-zа-яё]/i.test(ch));
    if (letters.length !== word.length) continue;
    const cyr = /[а-яё]/i.test(letters[0]);
    const vowelSet = cyr ? RU_VOWELS : EN_VOWELS;
    const vowels = letters.filter((ch) => vowelSet.includes(ch.toLowerCase())).length;
    if (vowels / letters.length <= 0.2) return true;
  }
  return false;
}

function readReviews() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeReviews(reviews) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reviews, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readBody(req) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY) {
    req.resume();
    return TOO_LARGE;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      return TOO_LARGE;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return sendText(res, 500, 'Не удалось прочитать страницу: отсутствует public/index.html');
    }
  }

  if (req.method === 'GET' && pathname === '/api/reviews') {
    return sendJson(res, 200, readReviews());
  }

  if (req.method === 'POST' && pathname === '/api/reviews') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Слишком много запросов. Подождите минуту и повторите.' });
    }
    const body = await readBody(req);
    if (body === TOO_LARGE) {
      return sendJson(res, 413, { error: 'Слишком большой запрос' });
    }
    if (!body) {
      return sendJson(res, 400, { error: 'Некорректный JSON' });
    }

    const rating = Number(body.rating);
    const menu = String(body.menu == null ? '' : body.menu).trim();
    const comment = String(body.comment == null ? '' : body.comment).trim();

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return sendJson(res, 400, { error: 'Укажите оценку визита от 1 до 5' });
    }
    if (menu.length > MAX_MENU) {
      return sendJson(res, 400, { error: 'Поле «Что понравилось из меню» слишком длинное' });
    }
    if (comment.length > MAX_COMMENT) {
      return sendJson(res, 400, { error: 'Комментарий слишком длинный' });
    }
    if (isRepetitive(menu)) {
      return sendJson(res, 400, { error: '«Что понравилось из меню» выглядит как набор повторяющихся символов' });
    }
    if (isJunkyWordText(menu)) {
      return sendJson(res, 400, { error: '«Что понравилось из меню» похоже на текст не в той раскладке — укажите позицию из меню' });
    }
    if (isRepetitive(comment)) {
      return sendJson(res, 400, { error: 'Комментарий выглядит как набор повторяющихся символов' });
    }

    const reviews = readReviews();
    const review = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      rating,
      menu,
      comment,
      createdAt: new Date().toISOString()
    };
    reviews.push(review);
    writeReviews(reviews);
    return sendJson(res, 201, review);
  }

  return sendText(res, 404, 'Не найдено');
});

server.listen(PORT, HOST, () => {
  console.log('Кофейня Уголёк: http://localhost:' + PORT);
});