# โครงสร้างฐานข้อมูล (Database)

Migration: [`db/migrations/0001_init.sql`](../db/migrations/0001_init.sql) — รันด้วย `npm run db:migrate` (ฐานข้อมูลในเครื่องแบบ PGlite ถูก migrate อัตโนมัติเมื่อเปิดครั้งแรก) ตาราง `schema_migrations` เก็บว่าไฟล์ใดถูกรันแล้ว แต่ละไฟล์รันใน transaction เดียว (สำเร็จทั้งไฟล์หรือไม่เปลี่ยนอะไรเลย)

## หลักการ

| หัวข้อ | การออกแบบ |
|---|---|
| การแยกข้อมูลผู้ใช้ | ทุกตารางข้อมูลส่วนบุคคลมี `user_id` + **Row Level Security** (`ENABLE` + `FORCE`) policy `user_id = app_current_user_id()` |
| สิทธิ์ของแอป | ทุกคำขอที่แตะข้อมูลผู้ใช้รันใน transaction ที่ `SET LOCAL ROLE app_user` และ `set_config('app.user_id', ...)` — role นี้ไม่มี BYPASSRLS ฐานข้อมูลจึงบังคับการแยกข้อมูลเอง ไม่ได้พึ่ง `WHERE` ในโค้ดอย่างเดียว |
| อ้างอิงข้ามผู้ใช้ | Foreign key แบบ composite `(user_id, id)` เช่น ธุรกรรมของผู้ใช้ A อ้างถึงบัญชีของผู้ใช้ B ไม่ได้ แม้รู้ id |
| ตารางระบบ | `users`, `sessions`, `password_reset_tokens`, `auth_attempts`, ตารางข้อมูลตลาด: เปิด RLS โดยไม่มี policy และไม่ grant ให้ `app_user` (เข้าถึงได้เฉพาะโค้ดฝั่งเซิร์ฟเวอร์ในส่วน auth/market) — ถ้าใช้ Supabase, Data API (anon key) ก็เข้าไม่ได้ |
| ตัวเลข | เงิน `numeric(20,4)`, จำนวนหุ้น `numeric(24,8)` (หุ้นเศษส่วน), ราคา `numeric(20,6)`, อัตราแลกเปลี่ยน `numeric(20,8)` |
| ยอดคงเหลือ | **ไม่เก็บยอดคงเหลือ** — ยอดเงินในบัญชี จำนวนหุ้น ต้นทุน และยอดหนี้ คำนวณจากรายการทุกครั้ง (ไม่มีโอกาสที่ยอดเก็บไว้จะไม่ตรงกับรายการ) |
| ป้องกันบันทึกซ้ำ | `unique (user_id, idempotency_key)` บนตารางรายการเงิน: กดปุ่มซ้ำหรือเน็ตหลุดแล้วส่งใหม่ ฐานข้อมูลรับครั้งเดียว |
| Audit | `audit_log` เก็บ before/after ของทุกการสร้าง/แก้/ลบ/นำเข้า/ยืนยัน `app_user` มีสิทธิ์แค่ INSERT/SELECT (แก้หรือลบประวัติไม่ได้) |

## ตาราง

### บัญชีผู้ใช้และระบบ
- `users` (email unique ไม่สนตัวพิมพ์, password_hash แบบ scrypt) · `sessions` (เก็บเฉพาะ SHA-256 ของ token) · `password_reset_tokens` (ใช้ครั้งเดียว อายุ 60 นาที) · `auth_attempts` (rate limit)
- `profiles`, `user_settings` (1:1 กับ users: สกุลเงินหลัก เขตเวลา ธีม เกณฑ์การแจ้งเตือน)

### เงินสดและการเงินส่วนบุคคล
- `accounts` — บัญชีเงินสด/ธนาคาร/โบรกเกอร์/ทรัพย์สินอื่น, `purpose`: general | emergency | goal (+`goal_id` → `savings_goals`), `opening_balance` = ยอดก่อนเริ่มบันทึก
- `transfers` — โอนระหว่างบัญชีของตัวเอง (`amount_from`/`amount_to` รองรับต่างสกุลเงิน, `fee`) ไม่ใช่รายรับ/รายจ่าย
- `income_records` — `status` expected | received (เฉพาะ received ที่มีบัญชีเท่านั้นที่เพิ่มเงินสด)
- `recurring_expenses` → สร้าง `expense_records` (status unpaid) ตามวันครบกำหนดอัตโนมัติ, unique `(recurring_id, expense_date)` กันสร้างซ้ำ
- `expense_records` — `status` paid | unpaid, `paid_date`, `is_essential` (ใช้คำนวณเป้าหมายเงินสำรอง)
- `liabilities` → `debt_payments` (`kind` payment | charge, `interest_amount` = ดอกเบี้ยจริงจาก statement หรือ null ให้ระบบประมาณ)
- `savings_goals`, `monthly_budgets` (unique ต่อเดือน+หมวด, `'*'` = งบรวม), `allocation_plans` (1 แผนต่อเดือน; `items` เป็น JSON เพราะอ่าน/เขียนทั้งก้อนเสมอ)

### การลงทุน
- `securities` — หลักทรัพย์ของผู้ใช้ (unique ต่อ ticker+ตลาด), `category`, `asset_group` (ใช้ตรวจการถือซ้ำซ้อน), ราคาบันทึกเอง `manual_price`/`manual_price_at`
- `portfolios` — ผู้ใช้ละ 2 พอร์ต: `main` (My Portfolio) และ `dca`
- `transactions` — สมุดบัญชีการลงทุน (buy/sell/dividend/fee/split/adjustment), `fx_rate` = บาทต่อ 1 หน่วยสกุลเงินของหุ้น ณ วันทำรายการ, `account_id` (ไม่บังคับ) ผูกผลต่อเงินสด, `source` manual/dca/import/watchlist, `import_hash`
- `watchlists` — แผนซื้อ (interested/waiting/bought/cancelled), เมื่อยืนยันซื้อจะผูก `transaction_id`
- `dca_plans` → `dca_allocations` (สัดส่วน %) และ `dca_schedule` (ตารางแผนรายวัน/รายเดือน; เมื่อซื้อจริงผูก `transaction_id` และสถานะเป็น executed)

### ข้อมูลตลาด (ใช้ร่วมกันทุกผู้ใช้ ไม่มีข้อมูลส่วนบุคคล)
- `market_quotes` (คีย์ symbol+exchange: `as_of` = เวลาของราคาตามผู้ให้บริการ, `fetched_at` = เวลาที่ระบบดึง, `data_type` realtime/delayed/eod, `source`)
- `price_history` + `price_history_meta` (ราคาปิดรายวัน), `security_fundamentals` (แคช 7 วัน), `exchange_rates` (base→quote ต่อวัน), `api_usage` (บันทึกการเรียก API เพื่อคุมโควตา)

## ความสัมพันธ์หลัก

```
users 1─1 profiles / user_settings
users 1─* accounts *─0..1 savings_goals
users 1─* securities 1─* transactions *─1 portfolios
                     1─* watchlists ─0..1 transactions
                     1─* dca_allocations *─1 dca_plans 1─* dca_schedule ─0..1 transactions
accounts 1─* transfers (from/to), income_records, expense_records, debt_payments, transactions
liabilities 1─* debt_payments
recurring_expenses 1─* expense_records
(securities.symbol, exchange) ··· market_quotes / price_history  (ข้อมูลตลาดกลาง)
```

## การเพิ่ม migration ใหม่
สร้างไฟล์ `db/migrations/0002_<ชื่อ>.sql` (เรียงตามชื่อไฟล์) แล้วรัน `npm run db:migrate` ห้ามแก้ไฟล์ที่ถูกรันไปแล้วในฐานข้อมูลจริง ตารางใหม่ที่มีข้อมูลผู้ใช้ต้องมี `user_id`, `enable/force row level security`, policy และ grant ให้ `app_user` แบบเดียวกับใน 0001
