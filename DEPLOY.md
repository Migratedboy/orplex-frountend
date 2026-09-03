# Deploy Orplex Tech — Free Tier Setup

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    YOUR USERS                        │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
    ┌─────▼─────┐           ┌──────▼──────┐
    │  Vercel   │           │  Railway /  │
    │ (Free)    │           │  Render /   │
    │ Frontend  │◄─────────►│  Fly.io     │
    │ + API     │  API calls│  Backend    │
    └─────┬─────┘           └──────┬──────┘
          │                        │
          │                  ┌─────▼─────┐
          │                  │  Supabase │
          └─────────────────►│  / Neon   │
                       DB    │  (Free)   │
                             └───────────┘
```

## Option A: All-in-One on Vercel (Simplest — $0)

Deploy the entire Next.js app (frontend + API) on Vercel.

### Steps
1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → Import your repo
3. Set environment variables (see below)
4. Deploy — done!

### Limitations
- API routes: 10s timeout on free tier (Hobby)
- No WebSocket support (serverless functions)
- 100GB bandwidth/month

---

## Option B: Split Deploy (Best — $0–$5/mo)

Frontend on Vercel, backend on Railway/Render/Fly.io.

### 1. Database (Free)

**Supabase (Recommended):**
1. Go to [supabase.com](https://supabase.com) → New Project
2. Copy the connection string: `postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT].supabase.co:5432/postgres`
3. Run migrations:
   ```bash
   DATABASE_URL="your-connection-string" npx prisma db push
   ```

**Neon (Alternative):**
1. Go to [neon.tech](https://neon.tech) → New Project
2. Copy the connection string
3. Same migration command

### 2. Backend (Pick One)

#### Railway ($5/mo credit — enough for small apps)
1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Set environment variables (see below)
3. Railway auto-detects Next.js and deploys
4. Get your URL: `https://orplex-tech-production.up.railway.app`

#### Render (Free — spins down after 15min)
1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install && npx prisma generate && npm run build`
   - **Start Command:** `npx prisma db push --skip-generate && npm run start`
4. Add environment variables
5. Deploy

#### Fly.io (Free — always-on, 256MB RAM)
1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Launch: `fly launch`
4. Set secrets: `fly secrets set DATABASE_URL="..." NEXTAUTH_SECRET="..."`
5. Deploy: `fly deploy`

### 3. Frontend (Vercel — Free)
1. Go to [vercel.com](https://vercel.com) → Import repo
2. Set **Root Directory** to `.` (or leave blank)
3. Set environment variables pointing to your backend:
   ```
   NEXT_PUBLIC_API_URL=https://your-backend.up.railway.app
   ```
4. Deploy

---

## Environment Variables

### For Vercel (Frontend)
```
NEXTAUTH_SECRET=your-secret-here
NEXTAUTH_URL=https://your-app.vercel.app
DATABASE_URL=your-supabase-or-neon-url
NEXT_PUBLIC_API_URL=https://your-backend.up.railway.app
```

### For Railway / Render / Fly.io (Backend)
```
NODE_ENV=production
NEXTAUTH_SECRET=your-secret-here
NEXTAUTH_URL=https://your-backend.up.railway.app
DATABASE_URL=your-supabase-or-neon-url
OPENROUTER_API_KEY=your-key
NVIDIA_API_KEY=your-key
PORT=3000
```

### Generate NEXTAUTH_SECRET
```bash
openssl rand -base64 32
```

---

## Free Tier Comparison

| Service | Free Allowance | Spin-Down | Best For |
|---------|---------------|-----------|----------|
| **Vercel** | 100GB bandwidth, 100K invocations | No (serverless) | Frontend + API routes |
| **Render** | 750 hrs/mo, 512MB RAM | Yes (15min idle) | Backend (low traffic) |
| **Fly.io** | 3 VMs, 256MB RAM each | No | Backend (always-on) |
| **Supabase** | 500MB DB, 50K monthly active users | No | PostgreSQL + Auth |
| **Neon** | 0.5GB DB, 24/7 compute (191.9 hrs/mo) | Yes (scale to zero) | PostgreSQL |

## Recommended Free Stack

```
Frontend:    Vercel (free)
Backend:     Fly.io (free, always-on) or Render (free, spins down)
Database:    Supabase (free, 500MB)
Auth:        NextAuth + Supabase Auth (free)
Storage:     Supabase Storage (free, 1GB)
```

**Total cost: $0/month**

## Post-Deploy Checklist

- [ ] Set NEXTAUTH_URL to your production URL
- [ ] Set NEXTAUTH_SECRET to a random string
- [ ] Run `npx prisma db push` to create tables
- [ ] Test API endpoints: `curl https://your-app/api/health`
- [ ] Test auth flow: sign in with Google/GitHub
- [ ] Set up custom domain (optional)
- [ ] Enable Vercel Analytics (optional)
- [ ] Set up Sentry for error tracking (optional)
