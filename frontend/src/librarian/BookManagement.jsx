import { useCallback, useEffect, useState } from 'react';
import IsbnBarcode from '../components/IsbnBarcode';

const API_BASE = 'http://localhost:3001/api/books';
const emptyForm = {
  isbn: '',
  title: '',
  author: '',
  genre: '',
  language: 'English',
  description: '',
};

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || payload.message || 'Request failed');
  }

  return payload;
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeIsbn(value) {
  return String(value || '')
    .trim()
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^ISBN(?:-1[03])?[：:]?/, '')
    .replace(/[^0-9X]/g, '');
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
  const language = String(value || '').trim().toLowerCase();

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
  };

  return languageMap[language] || value;
}

function joinNames(items) {
  if (!Array.isArray(items)) {
    return '';
  }

  return items
    .map((item) => String(item?.name || item || '').trim())
    .filter(Boolean)
    .join(', ');
}

function pickFirstText(items) {
  if (!Array.isArray(items)) {
    return '';
  }

  return String(items.find((item) => String(item || '').trim()) || '').trim();
}

function normalizeLookupResult(book, isbn) {
  const language = normalizeLanguageName(book.language, inferLanguageFromIsbn(isbn) || 'English');
  const defaultGenre = language === 'Chinese' ? '中文图书' : 'English Book';

  return {
    isbn,
    title: book.title || '',
    author: book.author || 'Unknown',
    genre: book.genre || defaultGenre,
    language,
    description: book.description || '',
  };
}

async function lookupFromOpenLibraryBooksApi(isbn) {
  const params = new URLSearchParams({
    bibkeys: `ISBN:${isbn}`,
    jscmd: 'data',
    format: 'json',
  });
  const result = await fetchJsonWithTimeout(`https://openlibrary.org/api/books?${params}`);
  const book = result?.[`ISBN:${isbn}`];

  if (!book?.title) {
    return null;
  }

  return normalizeLookupResult({
    title: book.title,
    author: joinNames(book.authors),
    genre: pickFirstText(book.subjects?.map((subject) => subject?.name)),
    description: book.notes || book.excerpts?.[0]?.text || '',
    language: 'English',
  }, isbn);
}

async function lookupFromOpenLibrarySearch(isbn) {
  const params = new URLSearchParams({
    isbn,
    fields: 'title,author_name,subject,language',
    limit: '1',
  });
  const result = await fetchJsonWithTimeout(`https://openlibrary.org/search.json?${params}`);
  const book = result?.docs?.[0];

  if (!book?.title) {
    return null;
  }

  return normalizeLookupResult({
    title: book.title,
    author: joinNames(book.author_name),
    genre: pickFirstText(book.subject),
    language: book.language?.[0] || 'English',
  }, isbn);
}

async function lookupFromGoogleBooks(isbn) {
  const params = new URLSearchParams({
    q: `isbn:${isbn}`,
    maxResults: '1',
  });
  const result = await fetchJsonWithTimeout(`https://www.googleapis.com/books/v1/volumes?${params}`);
  const volume = result?.items?.[0]?.volumeInfo;

  if (!volume?.title) {
    return null;
  }

  return normalizeLookupResult({
    title: volume.title,
    author: joinNames(volume.authors),
    genre: pickFirstText(volume.categories),
    description: volume.description || '',
    language: volume.language || 'English',
  }, isbn);
}

async function lookupBookInBrowser(isbn) {
  const providers = [
    lookupFromOpenLibraryBooksApi,
    lookupFromOpenLibrarySearch,
    lookupFromGoogleBooks,
  ];
  const results = await Promise.allSettled(
    providers.map((provider) => provider(isbn))
  );

  for (const providerResult of results) {
    if (providerResult.status === 'fulfilled' && providerResult.value?.title) {
      return providerResult.value;
    }
  }

  return null;
}

export default function BookManagement() {
  const [books, setBooks] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [selectedBook, setSelectedBook] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const librarianToken = localStorage.getItem('librarianToken');

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const loadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await readJson(await fetch(API_BASE));
      setBooks(payload.data || []);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBooks();
  }, [loadBooks]);

  const lookupByIsbn = async () => {
    const isbn = normalizeIsbn(form.isbn);

    if (!isbn) {
      setMessage('请先输入 ISBN');
      return;
    }

    setLookupLoading(true);
    setMessage('');
    setForm({
      ...emptyForm,
      isbn,
    });

    try {
      const params = new URLSearchParams({ isbn });
      let lookupData = null;
      let backendError = null;

      try {
        const payload = await readJson(await fetch(`${API_BASE}/lookup?${params}`));
        lookupData = payload.data;
      } catch (error) {
        backendError = error;
        lookupData = await lookupBookInBrowser(isbn);
      }

      if (!lookupData) {
        throw new Error(
          backendError
            ? `${backendError.message}；浏览器直连也没有获取到这本书的信息。`
            : '没有获取到这本书的信息'
        );
      }

      setForm((current) => ({
        ...current,
        isbn: lookupData.isbn || current.isbn,
        title: lookupData.title || '',
        author: lookupData.author || '',
        genre: lookupData.genre || '',
        language: lookupData.language || '',
        description: lookupData.description || '',
      }));
      setMessage('已通过 ISBN 获取图书信息');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const saveBook = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      await readJson(
        await fetch(API_BASE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${librarianToken}`,
          },
          body: JSON.stringify(form),
        })
      );
      setForm(emptyForm);
      setMessage('图书已添加，ISBN 条形码已自动生成');
      await loadBooks();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  const viewDetails = async (bookId) => {
    setMessage('');
    try {
      const payload = await readJson(await fetch(`${API_BASE}/${bookId}`));
      setSelectedBook(payload.data);
    } catch (error) {
      setMessage(error.message);
    }
  };

  return (
    <div className="space-y-6">
      {message && (
        <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {message}
        </div>
      )}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={saveBook} className="rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-xl font-bold text-gray-900">添加图书</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium text-gray-700 md:col-span-2">
              ISBN
              <div className="flex gap-2">
                <input
                  value={form.isbn}
                  onChange={(event) => updateForm('isbn', event.target.value)}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2"
                  placeholder="9780132350884"
                  required
                />
                <button
                  type="button"
                  onClick={lookupByIsbn}
                  disabled={lookupLoading}
                  className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {lookupLoading ? '获取中...' : '联网获取'}
                </button>
              </div>
            </label>

            <label className="grid gap-1 text-sm font-medium text-gray-700">
              书名
              <input
                value={form.title}
                onChange={(event) => updateForm('title', event.target.value)}
                className="rounded border border-gray-300 px-3 py-2"
                required
              />
            </label>

            <label className="grid gap-1 text-sm font-medium text-gray-700">
              作者
              <input
                value={form.author}
                onChange={(event) => updateForm('author', event.target.value)}
                className="rounded border border-gray-300 px-3 py-2"
                required
              />
            </label>

            <label className="grid gap-1 text-sm font-medium text-gray-700">
              分类
              <input
                value={form.genre}
                onChange={(event) => updateForm('genre', event.target.value)}
                className="rounded border border-gray-300 px-3 py-2"
                required
              />
            </label>

            <label className="grid gap-1 text-sm font-medium text-gray-700">
              语言
              <input
                value={form.language}
                onChange={(event) => updateForm('language', event.target.value)}
                className="rounded border border-gray-300 px-3 py-2"
              />
            </label>

            <label className="grid gap-1 text-sm font-medium text-gray-700 md:col-span-2">
              简介
              <textarea
                value={form.description}
                onChange={(event) => updateForm('description', event.target.value)}
                className="min-h-24 rounded border border-gray-300 px-3 py-2"
              />
            </label>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-5 py-2 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? '保存中...' : '保存图书'}
            </button>
          </div>
        </form>

        <aside className="rounded-lg bg-white p-6 shadow">
          <h3 className="mb-3 text-lg font-semibold text-gray-900">ISBN 条形码预览</h3>
          <IsbnBarcode isbn={form.isbn} />
        </aside>
      </section>

      <section className="rounded-lg bg-white p-6 shadow">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">馆藏图书</h2>
          <button
            type="button"
            onClick={loadBooks}
            className="rounded bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200"
          >
            刷新
          </button>
        </div>

        {loading ? (
          <p className="text-gray-500">加载中...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2">书名</th>
                  <th className="px-3 py-2">作者</th>
                  <th className="px-3 py-2">ISBN</th>
                  <th className="px-3 py-2">分类</th>
                  <th className="px-3 py-2">库存</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {books.map((book) => (
                  <tr key={book.id} className="border-b last:border-0">
                    <td className="px-3 py-3 font-medium text-gray-900">{book.title}</td>
                    <td className="px-3 py-3 text-gray-600">{book.author}</td>
                    <td className="px-3 py-3 text-gray-600">{book.isbn}</td>
                    <td className="px-3 py-3 text-gray-600">{book.genre}</td>
                    <td className="px-3 py-3 text-gray-600">
                      {book.availableCopies || 0} / {book.totalCopies || 0}
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => viewDetails(book.id)}
                        className="rounded bg-blue-50 px-3 py-1.5 text-blue-700 hover:bg-blue-100"
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{selectedBook.title}</h2>
                <p className="text-sm text-gray-500">ISBN: {selectedBook.isbn}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedBook(null)}
                className="rounded bg-gray-100 px-3 py-1 text-gray-700 hover:bg-gray-200"
              >
                关闭
              </button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 text-sm text-gray-700">
                <p><strong>作者：</strong>{selectedBook.author}</p>
                <p><strong>分类：</strong>{selectedBook.genre}</p>
                <p><strong>语言：</strong>{selectedBook.language}</p>
                <p><strong>库存：</strong>{selectedBook.availableCopies || 0} / {selectedBook.totalCopies || 0}</p>
              </div>
              <IsbnBarcode isbn={selectedBook.isbn} />
            </div>

            {selectedBook.description && (
              <p className="mt-4 text-sm leading-6 text-gray-700">{selectedBook.description}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
