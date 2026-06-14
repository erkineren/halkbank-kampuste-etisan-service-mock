const express = require('express');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const qr = require('./lib/qr');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const STATEFUL = (process.env.STATEFUL || 'true').toLowerCase() !== 'false';

// Kampüs Giriş QR — tek sabit key (gerçekte kuruma özel TBL_KURUM_CONFIG.KAMPUS_GIRIS_QR_PRIVATE_KEY).
// Default, entegrasyon rehberindeki örnek key'dir (bilinen test vektörü ile uyumlu).
const QR_PRIVATE_KEY =
  process.env.QR_PRIVATE_KEY ||
  '0x00000052,0x11221111,0x12345678,0x12345678,0x15645678,0x12345678,0xAAAAAA23,0xFFFFFFDD';

const loadJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));

const REZ_DEFAULT = loadJson('rezervasyonlar.default.json');
const YEMEKHANELER_DEFAULT = loadJson('yemekhaneler.default.json');
const DOLULUKLAR_DEFAULT = loadJson('doluluklar.default.json');

const REZ_CFG = REZ_DEFAULT._config || {};
const REZ_EKLE_SUCCESS_DESC = REZ_CFG.rezEkleSuccessMessage || 'Rezervasyon Onaylandı';
const REZ_EKLE_LOKASYON_AFTER = REZ_CFG.rezEkleLokasyonAfter || '';
const REZ_IPTAL_RC = typeof REZ_CFG.rezIptalSuccessReturnCode === 'number' ? REZ_CFG.rezIptalSuccessReturnCode : 1;
const REZ_IPTAL_DESC = REZ_CFG.rezIptalSuccessReturnDescription || 'Rezervasyon İptal Edildi';
const REZ_DEADLINE_MSG = REZ_CFG.rezDeadlineMessage || null;

const OPENAPI_DOC = yaml.load(
  fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'),
);

const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Swagger UI + raw spec
app.get('/openapi.json', (_req, res) => res.json(OPENAPI_DOC));
app.get('/openapi.yaml', (_req, res) => {
  res.type('text/yaml').send(yaml.dump(OPENAPI_DOC));
});
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(OPENAPI_DOC, {
    customSiteTitle: 'Etisan Mock — API Docs',
    swaggerOptions: { persistAuthorization: true },
  }),
);

// state[`${TCKN}_${KART_ID}`] = MENU[]
const state = new Map();

const stateKey = (tckn, kartId) => `${tckn || ''}_${kartId || ''}`;

const cloneList = () => JSON.parse(JSON.stringify(REZ_DEFAULT.RETURN_TABLE));

const getList = (tckn, kartId) => {
  if (!STATEFUL) return cloneList();
  const k = stateKey(tckn, kartId);
  if (!state.has(k)) state.set(k, cloneList());
  return state.get(k);
};

const fail = (description) => ({ RETURN_CODE: 0, RETURN_DESCRIPTION: description });
const ok = (description = 'İşlem başarılı') => ({
  RETURN_CODE: 1,
  RETURN_DESCRIPTION: description,
});

// 6 digit numeric — same shape as real service ("364273")
const randomOnayKodu = () => String(Math.floor(100000 + Math.random() * 900000));

const readBody = (req) => req.body || {};

// .NET default DateTime when none set
const DEFAULT_DOTNET_DATETIME = '0001-01-01T00:00:00';

// EKLE sonrası reserved item için EKLEME_CONFIG: tüm alanlar default + LOKASYON
const buildReservedEklemeConfig = (lokasyon) => ({
  PERIYOT: '',
  AMOUNT: 0.0,
  SEMA_ID: '',
  LOKASYON: lokasyon || '',
  KART_MIFARE_NO: '',
  GELEN_GUN: DEFAULT_DOTNET_DATETIME,
});

// POST /api/EtisanSistem/REZERVASYONLAR
app.post('/api/EtisanSistem/REZERVASYONLAR', (req, res) => {
  const body = readBody(req);
  const tckn = body.TCKN;
  const kartId = body.KART_ID;

  if (!tckn || kartId === undefined || kartId === null || kartId === '') {
    return res.json(fail('İşlem Başarısız.'));
  }

  const list = getList(tckn, kartId);
  return res.json({
    RETURN_CODE: 1,
    RETURN_DESCRIPTION: 'Rezervasyon Listesi Başarılı',
    RETURN_TABLE: list,
  });
});

// POST /api/EtisanSistem/REZERVASYON_EKLE
app.post('/api/EtisanSistem/REZERVASYON_EKLE', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID, YEMEKHANE_ID, EKLEME_CONFIG } = body;

  if (!TCKN || !KART_ID || !EKLEME_CONFIG) {
    return res.json(fail('İşlem Başarısız.'));
  }

  const semaId = (EKLEME_CONFIG.SEMA_ID || '').toString();
  const periyot = EKLEME_CONFIG.PERIYOT || '';
  const gelenGun = EKLEME_CONFIG.GELEN_GUN
    ? new Date(EKLEME_CONFIG.GELEN_GUN).toISOString().slice(0, 10)
    : '';

  if (STATEFUL) {
    const list = getList(TCKN, KART_ID);
    const matchIndex = list.findIndex((m) => {
      if (!m.EKLEME_CONFIG) return false;
      const sameSema = (m.EKLEME_CONFIG.SEMA_ID || '').toString() === semaId;
      const samePeriyot = (m.EKLEME_CONFIG.PERIYOT || '') === periyot;
      const sameGun =
        m.EKLEME_CONFIG.GELEN_GUN &&
        new Date(m.EKLEME_CONFIG.GELEN_GUN).toISOString().slice(0, 10) === gelenGun;
      return sameSema && samePeriyot && sameGun && m.REZERVASYONU_VARMI === 0;
    });

    if (matchIndex === -1) {
      return res.json(fail('Bu menü için rezervasyon eklenemedi.'));
    }

    // Yemekhane lookup → LOKASYON name
    const yemekhane = YEMEKHANELER_DEFAULT.RETURN_TABLE.find(
      (y) => Number(y.YEMEKHANE_ID) === Number(YEMEKHANE_ID),
    );
    const lokasyon =
      (yemekhane && yemekhane.YEMEKHANE_ADI) ||
      EKLEME_CONFIG.LOKASYON ||
      REZ_EKLE_LOKASYON_AFTER ||
      '';

    const item = list[matchIndex];
    const onayKodu = randomOnayKodu();
    item.REZERVASYONU_VARMI = 1;
    item.IPTAL_CONFIG = {
      PERIYOT: periyot,
      ONAY_KODU: onayKodu,
      KART_MIFARE_NO: EKLEME_CONFIG.KART_MIFARE_NO || '',
      LOKASYON: lokasyon,
    };
    item.EKLEME_CONFIG = buildReservedEklemeConfig(lokasyon);
    item.REZERVASYON_UYARI_METIN_BASLIK = null;
    item.REZERVASYON_UYARI_METIN_SUB = REZ_DEADLINE_MSG;
  }

  return res.json(ok(REZ_EKLE_SUCCESS_DESC));
});

// POST /api/EtisanSistem/REZERVASYON_IPTAL
app.post('/api/EtisanSistem/REZERVASYON_IPTAL', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID, IPTAL_CONFIG } = body;

  if (!TCKN || !KART_ID || !IPTAL_CONFIG) {
    return res.json(fail('İşlem Başarısız.'));
  }

  const onayKodu = (IPTAL_CONFIG.ONAY_KODU || '').toString();

  if (STATEFUL) {
    const list = getList(TCKN, KART_ID);
    const matchIndex = list.findIndex(
      (m) =>
        m.REZERVASYONU_VARMI === 1 &&
        m.IPTAL_CONFIG &&
        (m.IPTAL_CONFIG.ONAY_KODU || '').toString() === onayKodu,
    );

    if (matchIndex === -1) {
      return res.json(fail('İptal edilecek rezervasyon bulunamadı.'));
    }

    const item = list[matchIndex];
    const periyot = item.IPTAL_CONFIG.PERIYOT || '';

    // Restore from default fixture (find original row by MENU_ADI + PERIYOT)
    const original = REZ_DEFAULT.RETURN_TABLE.find(
      (orig) =>
        orig.EKLEME_CONFIG &&
        (orig.EKLEME_CONFIG.PERIYOT || '') === periyot &&
        orig.MENU_ADI === item.MENU_ADI,
    );

    item.REZERVASYONU_VARMI = 0;
    item.IPTAL_CONFIG = null;
    item.EKLEME_CONFIG = original
      ? JSON.parse(JSON.stringify(original.EKLEME_CONFIG))
      : null;
    item.REZERVASYON_UYARI_METIN_BASLIK = original
      ? original.REZERVASYON_UYARI_METIN_BASLIK
      : null;
    item.REZERVASYON_UYARI_METIN_SUB = original
      ? original.REZERVASYON_UYARI_METIN_SUB
      : null;
  }

  return res.json({
    RETURN_CODE: REZ_IPTAL_RC,
    RETURN_DESCRIPTION: REZ_IPTAL_DESC,
  });
});

// POST /api/EtisanSistem/YEMEKHANELER
app.post('/api/EtisanSistem/YEMEKHANELER', (req, res) => {
  const body = readBody(req);
  const tckn = body.TCKN;
  const kartId = body.KART_ID;

  if (!tckn || kartId === undefined || kartId === null || kartId === '') {
    return res.json(fail('İşlem Başarısız.'));
  }

  return res.json({
    RETURN_CODE: YEMEKHANELER_DEFAULT.RETURN_CODE,
    RETURN_DESCRIPTION: YEMEKHANELER_DEFAULT.RETURN_DESCRIPTION,
    RETURN_TABLE: YEMEKHANELER_DEFAULT.RETURN_TABLE,
  });
});

// POST /api/EtisanSistem/DOLULUKLAR
app.post('/api/EtisanSistem/DOLULUKLAR', (req, res) => {
  const body = readBody(req);
  const tckn = body.TCKN;
  const kartId = body.KART_ID;

  if (!tckn || kartId === undefined || kartId === null || kartId === '') {
    return res.json(fail('İşlem Başarısız.'));
  }

  return res.json({
    RETURN_CODE: DOLULUKLAR_DEFAULT.RETURN_CODE,
    RETURN_DESCRIPTION: DOLULUKLAR_DEFAULT.RETURN_DESCRIPTION,
    RETURN_TABLE: DOLULUKLAR_DEFAULT.RETURN_TABLE,
  });
});

// POST /api/EtisanSistem/KAREKOD
// Yemekhane geçişi: app kamerayla turnikedeki QR'ı okur, buraya gönderir.
// Bu akış ChaCha kullanmaz (gerçekte dış QR servisi doğrular). Mock: success/fail test için.
//   - scenario=fail (query veya body)  -> başarısız
//   - aksi halde                        -> başarılı
app.post('/api/EtisanSistem/KAREKOD', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID, KAREKOD } = body;

  if (!TCKN || KART_ID === undefined || KART_ID === null || KART_ID === '') {
    return res.json({ RETURN_CODE: 0, RETURN_DESCRIPTION: 'İşlem Başarısız.', RETURN_TABLE: null });
  }

  const scenario = (req.query.scenario || body.scenario || '').toString().toLowerCase();
  const failed = scenario === 'fail' || scenario === 'hata' || !KAREKOD;

  if (failed) {
    return res.json({
      RETURN_CODE: 0,
      RETURN_DESCRIPTION: 'Okuma işleminde hata oluştu.',
      RETURN_TABLE: null,
    });
  }

  return res.json({
    RETURN_CODE: 1,
    RETURN_DESCRIPTION: 'Okuma işlemi başarılı.',
    RETURN_TABLE: null,
  });
});

// POST /api/EtisanSistem/KampusGirisQrCode
// Kampüs giriş: app'in GÖSTERDİĞİ ChaCha şifreli QR metnini üretir (turnike okur/çözer).
app.post('/api/EtisanSistem/KampusGirisQrCode', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID } = body;

  if (!TCKN || KART_ID === undefined || KART_ID === null || KART_ID === '') {
    return res.json({ RETURN_CODE: 0, RETURN_DESCRIPTION: 'İşlem Başarısız.', RETURN_TABLE: null });
  }

  // Gerçekte plainData = kartın CardNum'u. Mock'ta KART_ID'den deterministik hex üretiyoruz.
  const plainData = Math.abs(parseInt(KART_ID, 10) || 0).toString(16).toUpperCase();
  const qrText = qr.generateQr(QR_PRIVATE_KEY, plainData);

  return res.json({
    RETURN_CODE: 1,
    RETURN_DESCRIPTION: 'İşlem Başarılı.',
    RETURN_TABLE: qrText,
  });
});

// --- Admin endpoints (mock-only) -------------------------------------------

// GET /__mock/qr/generate?plainData=A431DEEA[&key=0x..,..]
// Gerçek karta gerek olmadan, istenen ham veriyle geçerli bir kampüs giriş QR'ı üretir.
app.get('/__mock/qr/generate', (req, res) => {
  const plainData = (req.query.plainData || 'A431DEEA').toString();
  const key = (req.query.key || QR_PRIVATE_KEY).toString();
  try {
    const qrText = qr.generateQr(key, plainData);
    return res.json({
      ok: true,
      plainData,
      qr: qrText,
      ivTimestampUnix: qr.readTimestamp(qrText),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /__mock/qr/decode?qr=<hex>[&key=0x..,..]
// Bir QR metnini çözer (turnike decrypt davranışının doğrulanması için).
app.get('/__mock/qr/decode', (req, res) => {
  const qrText = (req.query.qr || '').toString();
  const key = (req.query.key || QR_PRIVATE_KEY).toString();
  if (!qr.isHex(qrText) || qrText.length < 16 || qrText.length % 2 !== 0) {
    return res.status(400).json({ ok: false, error: 'Geçersiz QR formatı (hex, ≥16, çift uzunluk).' });
  }
  try {
    const ts = qr.readTimestamp(qrText);
    return res.json({
      ok: true,
      plainData: qr.decryptQr(key, qrText),
      ivTimestampUnix: ts,
      ageSeconds: Math.floor(Date.now() / 1000) - ts,
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});
app.post('/__mock/reset', (_req, res) => {
  state.clear();
  res.json({ ok: true, cleared: true });
});

app.get('/__mock/state', (_req, res) => {
  const out = {};
  for (const [k, v] of state.entries()) out[k] = v;
  res.json(out);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((req, res) => {
  res.status(404).json(fail(`Endpoint bulunamadı: ${req.method} ${req.path}`));
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[etisan-mock] listening on http://${HOST}:${PORT} (stateful=${STATEFUL})`,
  );
});
