# Deploy: Google Sheets เป็นฐานข้อมูล + GitHub + Vercel

ผลลัพธ์: เว็บอยู่บน Vercel (ลิงก์ `https://<ชื่อโปรเจกต์>.vercel.app` ให้คนอื่นลองใช้ได้), ข้อมูลทุกบัญชีเก็บใน Google Sheet หนึ่งไฟล์, ทุกครั้งที่ push โค้ดขึ้น GitHub ระบบจะตรวจโค้ด (GitHub Actions) และ Vercel จะ deploy ใหม่ให้อัตโนมัติ

```
ผู้ใช้ ──► Vercel (Next.js) ──► PostgreSQL ในหน่วยความจำ (RLS, สูตรเดิมทั้งหมด)
                                   │  โหลดตอนเริ่ม / เขียนกลับเฉพาะแถวที่เปลี่ยน
                                   ▼
                             Google Sheet (1 แท็บ = 1 ตาราง, แท็บ _meta = ตัวกันข้อมูลทับกัน)
GitHub ──push──► GitHub Actions (typecheck, lint, test, build)
       └─────► Vercel (deploy อัตโนมัติ)
```

ใช้เวลาตั้งค่าครั้งแรกประมาณ 20-30 นาที ทุกขั้นตอนทำในบัญชีของคุณเอง (ไม่มีใครต้องรู้รหัสผ่านของคุณ)

---

## 1) สร้าง Service Account ใน Google Cloud (บัญชีที่เว็บใช้เขียน Google Sheet)

1. เปิด https://console.cloud.google.com/ → มุมบนซ้าย เลือก/สร้างโปรเจกต์ใหม่ เช่น `sinsap`
2. เมนู **APIs & Services → Library** → ค้นหา **Google Sheets API** → กด **Enable**
3. เมนู **IAM & Admin → Service Accounts → + Create service account**
   - Service account name: `sinsap-db` → **Create and continue** → ข้ามขั้น role ได้เลย → **Done**
4. คลิก service account ที่สร้าง → แท็บ **Keys → Add key → Create new key → JSON → Create**
   - ได้ไฟล์ `.json` หนึ่งไฟล์ — **นี่คือกุญแจลับ** อย่าใส่ในโฟลเดอร์โปรเจกต์ อย่าส่งทางแชต
   - ในไฟล์มี `"client_email": "sinsap-db@....iam.gserviceaccount.com"` ใช้ในขั้นที่ 2

> ถ้าใช้บัญชี Google Workspace ขององค์กรแล้วสร้าง key ไม่ได้ (ข้อความเรื่อง `iam.disableServiceAccountKeyCreation`) แปลว่าองค์กรปิดไว้ ให้ใช้บัญชี Gmail ส่วนตัวสร้างโปรเจกต์ Google Cloud แทน หรือขอผู้ดูแลระบบ

## 2) สร้าง Google Sheet ที่ใช้เป็นฐานข้อมูล

1. เปิด https://sheets.new → ตั้งชื่อ เช่น `Sinsap DB` (ไม่ต้องสร้างแท็บหรือหัวตารางเอง ระบบสร้างให้)
2. กด **Share** → ใส่อีเมล `client_email` จากขั้นที่ 1 → สิทธิ์ **Editor** → ยกเลิกติ๊ก Notify → **Share**
3. คัดลอก **Sheet ID** จาก URL: `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`

> ห้ามแชร์ไฟล์นี้ให้คนอื่น: ในไฟล์มีข้อมูลการเงินของผู้ใช้ทุกคน (รหัสผ่านถูกเก็บเป็น hash เท่านั้น แต่ข้อมูลอื่นอ่านได้)

## 3) ตั้งค่า Environment Variables บน Vercel

Vercel → โปรเจกต์ `sinsap` → **Settings → Environment Variables** → เพิ่มทีละตัว เลือก Environment = **Production**

| Key | Value |
|---|---|
| `GOOGLE_SHEETS_ID` | Sheet ID จากขั้นที่ 2 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | เปิดไฟล์ JSON จากขั้นที่ 1 ด้วย Notepad แล้ววาง **ทั้งไฟล์** |
| `APP_URL` | `https://sinsap.vercel.app` (หรือโดเมนจริงของโปรเจกต์) |

ไม่บังคับ: `TWELVEDATA_API_KEY` / `EODHD_API_KEY` (ราคาหุ้นอัตโนมัติ), `RESEND_API_KEY` + `EMAIL_FROM` (อีเมลรีเซ็ตรหัสผ่าน)

> อย่าใส่ค่าเหล่านี้ให้ **Preview** ถ้าไม่มี Google Sheet แยกสำหรับทดสอบ ไม่เช่นนั้น deploy ทดลองจาก Pull Request จะเขียนลงฐานข้อมูลจริง

## 4) อัปโหลดโค้ดขึ้น GitHub

1. ติดตั้ง Git: https://git-scm.com/download/win (ถ้ายังไม่มี)
2. สร้าง repository ใหม่ที่ https://github.com/new → ชื่อ `sinsap` → เลือก **Private** → **ไม่ต้อง**ติ๊ก README/.gitignore → Create
3. ในโฟลเดอร์โปรเจกต์ รัน (แทน URL ด้วยของคุณ):
   ```bash
   scripts\push-to-github.cmd https://github.com/YOUR-NAME/sinsap.git
   ```
   ครั้งแรกจะมีหน้าต่างให้ล็อกอิน GitHub สคริปต์จะไม่ยอมอัปโหลดถ้าพบไฟล์ลับ (`.env*`, `.data`, ไฟล์ key ของ Google ไม่ว่าจะตั้งชื่ออะไร)

   ไม่มี Git: อัปโหลดผ่านหน้าเว็บ GitHub ได้ (**Add file → Upload files** ลากไฟล์ทั้งหมดจากโฟลเดอร์ที่แตก zip) แต่หน้าเว็บรับครั้งละไม่เกิน 100 ไฟล์ ให้อัปโหลดโฟลเดอร์ `src` ก่อน แล้วค่อยอัปโหลดที่เหลือ

ไฟล์ `.github/workflows/ci.yml` จะทำให้ GitHub ตรวจ typecheck, lint, test (รวมทดสอบโหมด Google Sheets) และ build ทุกครั้งที่ push — ดูผลที่แท็บ **Actions** ของ repo

## 5) เชื่อม Vercel กับ GitHub แล้ว deploy

Vercel → โปรเจกต์ `sinsap` → **Settings → Git → Connect Git Repository** → เลือก `sinsap`

จากนั้นทุกครั้งที่ push ขึ้น `main` = deploy production อัตโนมัติ การเชื่อมเฉย ๆ ยังไม่ deploy และโปรเจกต์นี้ยังไม่มี deployment ให้กด Redeploy จึงต้องสั่งครั้งแรกเอง: **Deployments → ⋯ (มุมขวาบน) → Create Deployment** → พิมพ์ `main` → **Create Deployment** หรือแก้ไฟล์ใดก็ได้ใน GitHub (เช่น README.md) แล้ว Commit

ระหว่าง build สคริปต์ `npm run vercel-build` จะเชื่อม Google Sheet สร้างแท็บ/หัวตารางให้ และหยุด build พร้อมข้อความชัดเจนถ้าตั้งค่าไม่ครบ (เช่น ยังไม่ได้แชร์ Sheet ให้ service account)

## 6) ส่งลิงก์ beta

เปิด `https://sinsap.vercel.app` (ดูโดเมนจริงที่ Vercel → Domains) → สมัครบัญชีของคุณเองก่อนเพื่อทดลอง → ส่งลิงก์ให้ผู้ทดสอบ แต่ละคนสมัครบัญชีของตัวเอง ข้อมูลแยกกันด้วย Row Level Security

---

## ทดสอบกับ Google Sheet จริงบนเครื่องตัวเอง (ไม่บังคับ)

เพิ่มใน `.env.local` (ไฟล์นี้ไม่ถูกอัปโหลด) วางเนื้อหาไฟล์ JSON ทั้งไฟล์ระหว่างเครื่องหมาย `'` (single quote) หลายบรรทัดได้:

```
GOOGLE_SHEETS_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON='{
  "type": "service_account",
  ...ทั้งไฟล์...
}'
```

ถ้าไม่มี `'` ครอบ ระบบจะอ่านได้แค่บรรทัดแรก (`{`) แล้วแจ้งว่า JSON ไม่ถูกต้อง

แล้วรัน `npm run sheets:setup` (ตรวจสิทธิ์อ่าน/เขียนและสร้างแท็บ) และ `npm run dev` ใน **Command Prompt** (ถ้าใช้ PowerShell แล้วขึ้นว่า running scripts is disabled ให้พิมพ์ `npm.cmd` แทน `npm`)

## ข้อจำกัดของโหมด Google Sheets (เหมาะกับ beta ผู้ใช้ไม่มาก)

| เรื่อง | รายละเอียด |
|---|---|
| ความเร็ว | เปิดเว็บครั้งแรกหลังว่างนาน ~2-4 วินาที (โหลดทั้ง Sheet), การบันทึกแต่ละครั้ง ~1-2 วินาที |
| โควตา Google | ประมาณ 60 อ่าน + 60 เขียน ต่อนาที ต่อ service account รวมทุกผู้ใช้ → บันทึกได้ราว 20-30 ครั้ง/นาทีทั้งเว็บ เกินแล้วระบบรอแล้วลองใหม่ ถ้ายังเกินจะแจ้งให้ลองใหม่ |
| บันทึกพร้อมกัน | ใช้เลขเวอร์ชันในแท็บ `_meta` กันการเขียนทับ: เซิร์ฟเวอร์ที่ข้อมูลเก่าจะโหลดใหม่แล้วบันทึกซ้ำให้อัตโนมัติ ยังมีช่วงเวลาสั้นมากที่อาจชนกันได้ จึงไม่เหมาะกับผู้ใช้จำนวนมาก |
| ความปลอดภัย | การแยกข้อมูลผู้ใช้ยังบังคับด้วย RLS ใน PostgreSQL ตัวใน แต่ใครเข้าถึง Sheet ได้จะเห็นข้อมูลทุกคน → แชร์ Sheet ให้ service account และตัวคุณเท่านั้น |
| แก้ข้อมูลใน Sheet ด้วยมือ | ไม่ควรทำขณะเว็บทำงาน (อาจถูกเขียนทับ) ถ้าจำเป็น แก้แล้วเปลี่ยนค่า `_meta!B1` เป็นค่าใหม่ใด ๆ ให้เซิร์ฟเวอร์โหลดใหม่ ห้ามเปลี่ยนชื่อแท็บ/หัวคอลัมน์ |
| Rate limit การล็อกอิน | นับแยกต่อเซิร์ฟเวอร์ (ไม่เก็บลง Sheet) จึงหลวมกว่าโหมด PostgreSQL |
| ขนาด | Google Sheet จำกัด 10 ล้านเซลล์ต่อไฟล์ ใช้กับ beta ได้สบาย |
| สำรองข้อมูล | Google Sheets มี **File → Version history** ในตัว + ปุ่มส่งออก JSON/CSV ในหน้า Settings/History |

ถ้าผู้ใช้เพิ่มขึ้นมาก ให้ย้ายไป PostgreSQL (Neon/Supabase ฟรี): ตั้ง `DATABASE_URL` แทน `GOOGLE_SHEETS_ID` — โค้ดส่วนอื่นไม่ต้องแก้ (การย้ายข้อมูลเดิมจาก Sheet ยังต้องทำเอง)
