# CampusCart — Project Summary for the Team

_Status as of 15 Oct 2026. Phases 0–5 of 11 are finished and merged on GitHub ([eklvy/Orbiz](https://github.com/eklvy/Orbiz))._

This is a plain-language summary of what has been built, how, and what each part is called, so the team can
review it and suggest improvements. Please add comments or open GitHub issues against anything here.

---

## 1. What CampusCart is

Students get about 10 minutes between classes and lose most of it queuing at canteens. CampusCart lets a student
order before leaving class, choose a pickup time, pay, and collect the food with a digital token, without queuing.
Canteen managers and kitchen staff run everything from live dashboards.

The product requirements come from our **Team Orbiz report** (`CampusCart_Team_Orbiz_Report.pdf`). The code is a
**from-scratch rebuild**; nothing was copied from the earlier prototype.

## 2. The four apps (names)

| Name | Folder | Who uses it | What it does |
|---|---|---|---|
| **CampusCart** (student website) | `apps/student-web` | Students, faculty | Browse outlets and menus, order, pay, track the order live, wallet, rewards, groups |
| **CampusCart** (student mobile app) | `apps/student-mobile` | Students, faculty | Same core ordering and tracking on the phone (Expo / React Native) |
| **CampusCart Manager** | `apps/manager-dashboard` | Canteen managers, admins | Run an outlet: status, kitchen view, menu & stock, refunds, specials & polls, reviews, slots, staff, settings |
| **CampusCart Kitchen** (POS) | `apps/pos-dashboard` | Kitchen / counter staff | Live order board, mark orders ready, hand over with pickup code or QR scan |

All four talk to **one backend** (the **CampusCart API**, `services/api`) and **one database** (Supabase / Postgres).

## 3. How it is built (tech)

| Part | Technology | Why |
|---|---|---|
| Websites and dashboards | Next.js 16, React 19, Tailwind CSS | Fast, modern, works on phone and laptop |
| Mobile app | Expo (React Native) | One codebase for iOS and Android |
| Backend API | Python, FastAPI | The only part allowed to change business data |
| Database, login, live updates | Supabase (Postgres, Auth, Realtime) | Row-level security, instant live updates |
| Payments | Razorpay (test mode) | Indian payments (UPI / cards) |
| Shared code | `packages/client`, `packages/contracts`, `packages/staff-web` | Same logic and types in every app, no duplication |

**Important design rules we follow:**
- **The server decides everything that matters**: prices, totals, stock, slot capacity, payment and order status.
  The apps only display what the server says.
- **Money is stored in paise (whole numbers)**, never decimals, so there are no rounding errors.
- **Every database table has access rules** (row-level security): a student sees only their own orders, a manager
  only their own outlet.
- **Order status follows a fixed rulebook** (placed → accepted → preparing → ready → collected, plus cancelled /
  rejected / not collected). Nobody can skip steps.
- **Money records can't be edited or deleted** (wallet and points ledgers are append-only).
- **No fake data**: empty screens say they're empty; test data is clearly fictional (“Dev Sample North Café”).

## 4. What each phase delivered

| Phase | Name | What was built |
|---|---|---|
| 0 | Setup | Project structure, tooling, automatic checks on GitHub, architecture and requirements documents |
| 1 | Accounts & security | Register / sign in with campus email; roles (student, faculty, manager, kitchen staff, admin); access rules on every table; audit log |
| 2 | Ordering engine | Menus, stock, pickup slots, server-side cart (same cart on every device), orders with tokens and pickup codes, live updates, unpaid orders released automatically. Stock and slots can't be oversold (tested with 25 people ordering at once) |
| 3 | Student apps | Website and mobile app: outlets, menu with filters and search, cart, pickup time, live order tracking, QR **Digital Food Pass**, order history, profile |
| 4 | Manager & kitchen apps | Live kitchen board, pickup by code or QR, cafe Open / Break / Close, menu & stock, refunds desk, slots & hours, staff, settings, and the **no-show policy** (below) |
| 5 | Money & social | Razorpay payments, **CampusCart wallet**, loyalty points & vouchers, budget planner, notification centre, daily specials, student polls, reviews & ratings, “popular with your classmates”, **group orders**, party bookings, bill splits |

### Feature details worth reviewing

- **No-show policy** (decided by us): if a ready order isn't collected within **15 minutes after the pickup slot
  ends**, there's **no refund**. Sealed/packaged items (e.g. bottled drinks) go back into stock; freshly made food
  is offered to other students at **50% off for 30 minutes**. If someone buys it, the kitchen screen shows the new
  owner automatically. (All three numbers can be changed per outlet by the manager.)
- **Loyalty** (decided by us): 1 point per ₹10 paid; +50 for a single wallet top-up of ₹999 or more; +15 for a
  review. Tiers: Silver (0), Gold (1,000), Platinum (3,000 lifetime points). 100 points = a ₹10 voucher. Points are
  taken back if the order is refunded.
- **Refunds**: students can ask for a refund up to 24 hours after pickup; the manager approves or declines with a
  note. Refunds go to the student's CampusCart wallet automatically within a minute.
- **Group orders**: one person starts a group, friends join with a 6-letter code, everyone adds their dishes, the
  host checks out, and each person pays their own share from their wallet (split by dish, equally, or by
  percentage). The kitchen gets the order only when everyone has paid; if someone doesn't pay in 15 minutes,
  everyone who paid gets their money back.
- **Polls**: students vote (one vote each) on tomorrow's special and see live percentages; the **manager decides**
  and publishes the winner with the discount they choose.
- **Reviews** rate taste, hygiene, pickup speed and value (1–5). They're public but **anonymous**; the kitchen can
  reply.
- **Privacy**: “popular with your classmates” only shows an item once **at least 5 different students** ordered it,
  and never shows who.
- **Wait time and crowd level** are estimated from real orders, not cameras or sensors (we don't have any).

## 5. Decisions we made (please review)

| Topic | Decision |
|---|---|
| Campus navigation / RL Campus Navigator | **Removed** from scope |
| Guest ordering | Not allowed; guests can browse menus only |
| Sign in | Campus email + password (roll number stored on the profile) |
| ₹500 signup bonus (shown in the report) | **Not given** (it's real money someone would have to fund) |
| Pay at the counter (cash/UPI) | **No** — online/wallet only |
| No-show policy | 15 min after slot end, no refund, packaged items restocked, food sold at 50% off |
| Loyalty rules | As in section 4 |
| Where refunds go | Student's CampusCart wallet (not back to the card) — _default, open to change_ |
| Wallet limits | Top-up ₹50–₹5,000; wallet holds at most ₹10,000; no withdrawal to bank — _default_ |
| Mobile payments | Mobile app pays from the wallet; top-ups on the website — _default_ |
| Group / party / split limits | Group ≤ 10 people; party bookings 24 h – 60 days ahead; bill splits ≤ 10 people — _default_ |

Full list with reasons: [`docs/REQUIREMENTS.md`](REQUIREMENTS.md).

## 6. How we know it works (testing)

Every change is checked by one command, `bash scripts/verify.sh`, and again on GitHub. Latest run: **all passed**.

| Kind of test | Count | What it checks |
|---|---|---|
| Database tests | 420 | Access rules (who can see/change what), money rules, stock, no-shows, payments |
| API tests | 99 | The backend with real login and database, incl. payments, races, refunds |
| Shared logic tests | 23 | Prices formatting, QR codes, rupee input without rounding errors |
| Browser tests | 59 | Real clicking through the website, mobile app (web build), manager and kitchen apps; accessibility and phone-width layout |

## 7. What is not done yet

- **Online payment and phone push notifications** are built but tested only against mock services, because we
  haven't added Razorpay test keys or an Expo push token yet.
- **The mobile app hasn't run on a real phone yet** (it works as a web build; Expo Go on a phone is the next step).
  Group orders, party bookings and bill splits are website-only for now.
- **Remaining phases:**
  - **6A–6C:** AI advisors — a **Kitchen Dispatcher** (suggests which order to cook next) and a **Slot Nudger**
    (suggests less busy pickup times). They can only choose from options the server allows and always fall back to
    simple rules.
  - **7:** **BiteBot** chat assistant, **Surprise Meal** combo builder, and demand forecasting for managers.
  - **8:** Final end-to-end testing, security review, performance, and getting ready to deploy.
- We still need: the **real list of outlets and menus**, the **allowed college email domain(s)**, and where we'll
  **host** it.

## 8. How to try it (on the developer's laptop)

| App | Address | Test account (password `DevOnly-CampusCart-2026`) |
|---|---|---|
| Student website | http://localhost:3100 | `student.one@campuscart.test` |
| Manager | http://localhost:3101 | `manager.north@campuscart.test` |
| Kitchen (POS) | http://localhost:3102 | `kitchen.north@campuscart.test` |

These are fictional accounts on a local test database only.

## 9. Questions for the team

1. Are the **no-show** rules fair (15 minutes, no refund, 50% off for others)?
2. Are the **loyalty** numbers right (points per ₹10, tier levels, voucher value)?
3. Should refunds go back to the **card/UPI** instead of the wallet?
4. Are the **wallet limits** sensible for students?
5. Which features from the report matter most for the **demo**, and is anything missing or wrong?
6. Should **BiteBot** use an AI service (e.g. a paid API), or only built-in rules?
7. Can we get the **real outlet list, menus and prices**, and the **college email domain**?

---

_More detail: [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) (every phase, results and limitations),
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (how it fits together), [`docs/API.md`](API.md) (backend endpoints)._
