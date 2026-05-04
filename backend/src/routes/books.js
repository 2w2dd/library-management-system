const express = require('express');

const prisma = require('../lib/prisma');
const { requireLibrarianAuth } = require('../middleware/librarianAuth');

const router = express.Router();
const LOOKUP_TIMEOUT_MS = 7000;

const BOOK_SELECT = {
  id: true,
  title: true,
  author: true,
  isbn: true,
  genre: true,
  description: true,
  language: true,
  createdAt: true,
};

const BOOK_DETAIL_INCLUDE = {
  ratings: {
    orderBy: { createdAt: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          studentId: true,
        },
      },
    },
  },
  holds: {
    orderBy: { createdAt: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          studentId: true,
        },
      },
    },
  },
  wishlists: {
    orderBy: { createdAt: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          studentId: true,
        },
      },
    },
  },
  _count: {
    select: {
      ratings: true,
      holds: true,
      wishlists: true,
      copies: true,
    },
  },
};

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIsbn(value) {
  const normalizedCharacters = normalizeText(value)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^ISBN(?:-1[03])?[：:]?/, '');
  return normalizedCharacters.replace(/[^0-9X]/g, '');
}

function isLookupIsbn(value) {
  return /^(?:\d{10}|\d{9}X|\d{13})$/.test(value);
}

function inferLanguageFromIsbn(isbn) {
  if (/^97[89][01]/.test(isbn) || /^[01]/.test(isbn)) {
    return 'English';
  }

  if (/^9787/.test(isbn) || /^7/.test(isbn)) {
    return 'Chinese';
  }

  return '';
}

function normalizeLanguageName(value, fallback = 'English') {
  const language = normalizeText(value).toLowerCase();

  if (!language) {
    return fallback;
  }

  const languageMap = {
    en: 'English',
    eng: 'English',
    english: 'English',
    zh: 'Chinese',
    zho: 'Chinese',
    chi: 'Chinese',
    cn: 'Chinese',
    chinese: 'Chinese',
    ja: 'Japanese',
    jpn: 'Japanese',
    japanese: 'Japanese',
    fr: 'French',
    fre: 'French',
    fra: 'French',
    french: 'French',
    de: 'German',
    deu: 'German',
    ger: 'German',
    german: 'German',
    es: 'Spanish',
    spa: 'Spanish',
    spanish: 'Spanish',
  };

  return languageMap[language] || value;
}

function pickFirstText(values) {
  if (!Array.isArray(values)) {
    return '';
  }
  return normalizeText(values.find((value) => normalizeText(value)));
}

function extractDescription(description) {
  if (typeof description === 'string') {
    return normalizeText(description);
  }
  if (description && typeof description.value === 'string') {
    return normalizeText(description.value);
  }
  return '';
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Remote lookup failed with status ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status === 404) {
      return '';
    }

    if (!response.ok) {
      throw new Error(`Remote lookup failed with status ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtmlEntities(value) {
  return normalizeText(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeHtmlEntities(
    normalizeText(value)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function matchFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function joinNames(items) {
  if (!Array.isArray(items)) {
    return '';
  }
  return items
    .map((item) => normalizeText(item?.name || item))
    .filter(Boolean)
    .join(', ');
}

function joinTexts(items) {
  if (!Array.isArray(items)) {
    return '';
  }
  return items
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .join(', ');
}

async function fetchOpenLibraryAuthorName(authorReference) {
  const authorKey = authorReference?.author?.key || authorReference?.key;

  if (!authorKey) {
    return '';
  }

  const author = await fetchJson(`https://openlibrary.org${authorKey}.json`);
  return normalizeText(author?.name);
}

async function lookupOpenLibraryBook(isbn) {
  const book = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);

  if (!book) {
    return null;
  }

  const authorNames = await Promise.all(
    (book.authors || []).slice(0, 3).map(async (author) => {
      try {
        return await fetchOpenLibraryAuthorName(author);
      } catch (error) {
        return '';
      }
    })
  );
  const languageCode = normalizeText(book.languages?.[0]?.key).split('/').pop();

  return {
    title: normalizeText(book.title),
    author: authorNames.filter(Boolean).join(', ') || normalizeText(book.by_statement),
    isbn,
    genre: pickFirstText(book.subjects) || 'Uncategorized',
    description: extractDescription(book.description),
    language: normalizeLanguageName(languageCode, inferLanguageFromIsbn(isbn) || 'English'),
  };
}

async function lookupOpenLibraryBooksApi(isbn) {
  const params = new URLSearchParams({
    bibkeys: `ISBN:${isbn}`,
    jscmd: 'data',
    format: 'json',
  });
  const result = await fetchJson(`https://openlibrary.org/api/books?${params}`);
  const book = result?.[`ISBN:${isbn}`];

  if (!book) {
    return null;
  }

  return {
    title: normalizeText(book.title),
    author: joinNames(book.authors),
    isbn,
    genre: pickFirstText(book.subjects?.map((subject) => subject?.name)) || 'Uncategorized',
    description: normalizeText(book.notes) || normalizeText(book.excerpts?.[0]?.text),
    language: 'English',
  };
}

async function lookupOpenLibrarySearch(isbn) {
  const params = new URLSearchParams({
    isbn,
    fields: 'title,author_name,subject,language,isbn',
    limit: '1',
  });
  const result = await fetchJson(`https://openlibrary.org/search.json?${params}`);
  const book = result?.docs?.[0];

  if (!book) {
    return null;
  }

  return {
    title: normalizeText(book.title),
    author: joinTexts(book.author_name),
    isbn,
    genre: pickFirstText(book.subject) || 'Uncategorized',
    description: '',
    language: normalizeLanguageName(book.language?.[0], inferLanguageFromIsbn(isbn) || 'English'),
  };
}

async function lookupGoogleBooksBook(isbn) {
  const params = new URLSearchParams({
    q: `isbn:${isbn}`,
    maxResults: '1',
  });
  const result = await fetchJson(`https://www.googleapis.com/books/v1/volumes?${params}`);
  const volume = result?.items?.[0]?.volumeInfo;

  if (!volume) {
    return null;
  }

  return {
    title: normalizeText(volume.title),
    author: Array.isArray(volume.authors) ? volume.authors.join(', ') : '',
    isbn,
    genre: pickFirstText(volume.categories) || 'Uncategorized',
    description: normalizeText(volume.description),
    language: normalizeLanguageName(volume.language, inferLanguageFromIsbn(isbn) || 'English'),
  };
}

function parseDoubanInfoField(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<span\\s+class=["']pl["']>\\s*${escapedLabel}\\s*:?\\s*<\\/span>\\s*:?\\s*([\\s\\S]*?)<br\\s*\\/?\\s*>`,
    'i'
  );
  return stripHtml(matchFirst(html, pattern));
}

function parseDoubanAuthor(html) {
  const authorBlock = matchFirst(
    html,
    /<span>\s*<span\s+class=["']pl["']>\s*作者\s*<\/span>\s*:?\s*([\s\S]*?)<\/span>\s*<br\s*\/?\s*>/i
  );
  return stripHtml(authorBlock).replace(/\s*\/\s*/g, ', ');
}

function parseDoubanDescription(html) {
  const fullDescription = matchFirst(
    html,
    /<span\s+class=["']all hidden["']>[\s\S]*?<div\s+class=["']intro["']>([\s\S]*?)<\/div>/i
  );
  const shortDescription = matchFirst(
    html,
    /<span\s+class=["']short["']>[\s\S]*?<div\s+class=["']intro["']>([\s\S]*?)<\/div>/i
  );
  return stripHtml(fullDescription || shortDescription);
}

async function lookupDoubanBook(isbn) {
  const html = await fetchText(`https://book.douban.com/isbn/${encodeURIComponent(isbn)}/`);

  if (!html) {
    return null;
  }

  const jsonLd = matchFirst(
    html,
    /<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i
  );
  let structuredBook = null;

  if (jsonLd) {
    try {
      structuredBook = JSON.parse(jsonLd);
    } catch (error) {
      structuredBook = null;
    }
  }

  const title =
    normalizeText(structuredBook?.name) ||
    matchFirst(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    matchFirst(html, /<title>\s*([\s\S]*?)\s*\(豆瓣\)\s*<\/title>/i);

  if (!title) {
    return null;
  }

  const author =
    joinNames(structuredBook?.author) ||
    matchFirst(html, /<meta\s+property=["']book:author["']\s+content=["']([^"']+)["']/i) ||
    parseDoubanAuthor(html);
  const publisher = parseDoubanInfoField(html, '出版社');
  const publishYear = parseDoubanInfoField(html, '出版年');
  const language = parseDoubanInfoField(html, '语言');
  const inferredLanguage = inferLanguageFromIsbn(isbn);
  const displayLanguage = normalizeLanguageName(language, inferredLanguage || 'Chinese');
  const defaultGenre = displayLanguage === 'Chinese' ? '中文图书' : 'English Book';
  const publicationLabel = displayLanguage === 'Chinese' ? '出版' : 'Publication';
  const description =
    parseDoubanDescription(html) ||
    matchFirst(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
    matchFirst(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

  return {
    title,
    author,
    isbn,
    genre: defaultGenre,
    description: [
      publisher && `${publicationLabel}：${publisher}`,
      publishYear && `${displayLanguage === 'Chinese' ? '出版年' : 'Publication year'}：${publishYear}`,
      description,
    ].filter(Boolean).join('\n\n'),
    language: displayLanguage,
  };
}

async function lookupJisuBook(isbn) {
  const appkey = normalizeText(process.env.JISU_ISBN_APPKEY);

  if (!appkey) {
    return null;
  }

  const params = new URLSearchParams({ appkey, isbn });
  const result = await fetchJson(`https://api.jisuapi.com/isbn/query?${params}`);
  const book = result?.result;

  if (!book) {
    return null;
  }

  return {
    title: normalizeText(book.title),
    author: normalizeText(book.author),
    isbn,
    genre: normalizeText(book.class) || normalizeText(book.keyword) || 'Uncategorized',
    description: normalizeText(book.summary),
    language: normalizeLanguageName(book.language, inferLanguageFromIsbn(isbn) || 'Chinese'),
  };
}

async function lookupJuheBook(isbn) {
  const key = normalizeText(process.env.JUHE_ISBN_KEY);

  if (!key) {
    return null;
  }

  const params = new URLSearchParams({ key, sub: isbn });
  const result = await fetchJson(`https://feedback.api.juhe.cn/ISBN?${params}`);
  const book = result?.result || result?.data;

  if (!book) {
    return null;
  }

  return {
    title: normalizeText(book.title || book.bookname),
    author: normalizeText(book.author),
    isbn,
    genre: normalizeText(book.catalog || book.class) || 'Uncategorized',
    description: normalizeText(book.summary || book.introduction),
    language: normalizeLanguageName(book.language, inferLanguageFromIsbn(isbn) || 'Chinese'),
  };
}

async function lookupBookByIsbn(isbn) {
  const providers = [
    lookupDoubanBook,
    lookupOpenLibraryBooksApi,
    lookupOpenLibrarySearch,
    lookupOpenLibraryBook,
    lookupGoogleBooksBook,
    lookupJisuBook,
    lookupJuheBook,
  ];

  const providerResults = await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await provider(isbn);
        return { result, error: null };
      } catch (error) {
        return { result: null, error };
      }
    })
  );

  for (const { result } of providerResults) {
    if (result?.title) {
      return {
        ...result,
        author: result.author || 'Unknown',
        genre: result.genre || 'Uncategorized',
        language: normalizeLanguageName(result.language, inferLanguageFromIsbn(isbn) || 'English'),
      };
    }
  }

  for (const { error } of providerResults) {
    if (error) {
      console.warn('ISBN lookup provider failed:', error.message);
    }
  }

  return null;
}

async function lookupBookByKeyword(isbn) {
  const params = new URLSearchParams({
    q: isbn,
    fields: 'title,author_name,subject,language,isbn',
    limit: '1',
  });

  try {
    const result = await fetchJson(`https://openlibrary.org/search.json?${params}`);
    const book = result?.docs?.[0];

    if (!book) {
      return null;
    }

    return {
      title: normalizeText(book.title),
      author: joinTexts(book.author_name) || 'Unknown',
      isbn,
      genre: pickFirstText(book.subject) || 'Uncategorized',
      description: '',
      language: normalizeLanguageName(book.language?.[0], inferLanguageFromIsbn(isbn) || 'English'),
    };
  } catch (error) {
    console.warn('ISBN keyword lookup failed:', error.message);
    return null;
  }
}

async function lookupBook(isbn) {
  const directResult = await lookupBookByIsbn(isbn);

  if (directResult) {
    return directResult;
  }

  return lookupBookByKeyword(isbn);
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isNaN(parsedValue) ? Number.NaN : parsedValue;
}

async function writeAuditLog(action, entityId, detail) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entity: 'Book',
        entityId,
        detail,
      },
    });
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}

// 获取所有图书
router.get('/', async (req, res) => {
  try {
    const books = await prisma.book.findMany({
      orderBy: { id: 'asc' },
      include: {
        copies: {
          select: { status: true }
        }
      }
    });

    const booksWithCount = books.map(book => {
      const availableCopies = book.copies.filter(c => c.status === 'AVAILABLE').length;
      return {
        ...book,
        availableCopies: availableCopies,
        totalCopies: book.copies.length
      };
    });

    res.json({ data: booksWithCount });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch books',
      detail: error.message,
    });
  }
});

// 图书搜索功能 - 按书名、作者、关键词查找
router.get('/search', async (req, res) => {
  try {
    const { title, author, keyword, isbn } = req.query;
    
    const whereCondition = {};
    
    if (title || author || keyword || isbn) {
      whereCondition.OR = [];
      
      if (title) {
        whereCondition.OR.push({ title: { contains: title } });
      }
      
      if (author) {
        whereCondition.OR.push({ author: { contains: author } });
      }
      
      if (keyword) {
        whereCondition.OR.push(
          { title: { contains: keyword } },
          { author: { contains: keyword } }
        );
      }

      if (isbn) {
        whereCondition.OR.push({ isbn: { contains: normalizeText(isbn) } });
      }
    }
    
    const books = await prisma.book.findMany({
      where: whereCondition,
      orderBy: { id: 'asc' },
      include: {
        copies: {
          select: { status: true }
        }
      }
    });
    
    const booksWithCount = books.map(book => {
      const availableCopies = book.copies.filter(c => c.status === 'AVAILABLE').length;
      return {
        id: book.id,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        genre: book.genre,
        description: book.description,
        language: book.language,
        createdAt: book.createdAt,
        availableCopies: availableCopies,
        totalCopies: book.copies.length
      };
    });
    
    res.json({ 
      success: true, 
      data: booksWithCount,
      count: booksWithCount.length 
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to search books',
      detail: error.message,
    });
  }
});

// 通过 ISBN 联网获取图书元数据，供馆员添加图书时自动填表
router.get('/lookup', async (req, res) => {
  const isbn = normalizeIsbn(req.query.isbn);

  if (!isLookupIsbn(isbn)) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid ISBN-10 or ISBN-13',
    });
  }

  try {
    const book = await lookupBook(isbn);

    if (!book) {
      return res.status(404).json({
        success: false,
        error: 'No online book information found for this ISBN. Please check your network or fill the book fields manually.',
      });
    }

    return res.json({
      success: true,
      data: {
        ...book,
        isbnBarcode: isbn,
      },
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: 'Failed to fetch online book information',
      detail: error.message,
    });
  }
});

// 获取单本图书详情
router.get('/:id', async (req, res) => {
  const bookId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(bookId)) {
    return res.status(400).json({ error: 'Invalid book id' });
  }

  try {
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      include: {
        ...BOOK_DETAIL_INCLUDE,
        copies: {
          select: {
            id: true,
            barcode: true,
            floor: true,
            libraryArea: true,
            shelfNo: true,
            shelfLevel: true,
            status: true,
            loans: {
              orderBy: { checkoutDate: 'desc' },
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    studentId: true,
                  },
                },
              },
            },
          }
        }
      }
    });

    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const ratingCount = book.ratings.length;
    const averageRating =
      ratingCount === 0
        ? null
        : Number((book.ratings.reduce((sum, rating) => sum + rating.stars, 0) / ratingCount).toFixed(2));

    const loans = book.copies.flatMap((copy) => copy.loans || []);
    const copies = book.copies.map(({ loans: _loans, ...copy }) => copy);
    const availableCopies = copies.filter(c => c.status === 'AVAILABLE').length;

    res.json({
      success: true,
      data: {
        ...book,
        copies,
        loans,
        isbnBarcode: book.isbn,
        availableCopies: availableCopies,
        totalCopies: copies.length,
        stats: {
          averageRating,
          activeLoans: loans.filter((loan) => !loan.returnDate).length,
          returnedLoans: loans.filter((loan) => Boolean(loan.returnDate)).length,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch book detail',
      detail: error.message,
    });
  }
});

router.post('/', requireLibrarianAuth, async (req, res) => {
  const title = normalizeText(req.body.title);
  const author = normalizeText(req.body.author);
  const isbn = normalizeIsbn(req.body.isbn);
  const genre = normalizeText(req.body.genre);
  const description = normalizeText(req.body.description) || null;
  const language = normalizeText(req.body.language) || 'English';

  if (!title || !author || !isbn || !genre) {
    return res.status(400).json({
      error: 'title, author, isbn and genre are required',
    });
  }

  try {
    const book = await prisma.book.create({
      data: {
        title,
        author,
        isbn,
        genre,
        description,
        language,
      },
      select: BOOK_SELECT,
    });

    await writeAuditLog(
      'CREATE_BOOK',
      book.id,
      `Librarian ${req.librarian.employeeId} created book "${book.title}" (${book.isbn}).`
    );

    return res.status(201).json({
      message: 'Book created successfully',
      book: {
        ...book,
        isbnBarcode: book.isbn,
      },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'A book with this ISBN already exists',
      });
    }

    return res.status(500).json({
      error: 'Failed to create book',
      detail: error.message,
    });
  }
});

router.delete('/:id', requireLibrarianAuth, async (req, res) => {
  const bookId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(bookId)) {
    return res.status(400).json({ error: 'Invalid book id' });
  }

  try {
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        title: true,
        isbn: true,
        _count: {
          select: {
            ratings: true,
            holds: true,
            wishlists: true,
            copies: true,
          },
        },
      },
    });

    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const relatedRecordCount =
      book._count.ratings +
      book._count.holds +
      book._count.wishlists +
      book._count.copies;

    if (relatedRecordCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete a book that already has related borrowing or interaction records',
      });
    }

    await prisma.book.delete({
      where: { id: bookId },
    });

    await writeAuditLog(
      'DELETE_BOOK',
      book.id,
      `Librarian ${req.librarian.employeeId} deleted book "${book.title}" (${book.isbn}).`
    );

    return res.json({
      message: 'Book deleted successfully',
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to delete book',
      detail: error.message,
    });
  }
});

module.exports = router;
