#!/bin/bash
# setup-codespace.sh — Run this after opening a GitHub Codespace
# Sets up PostgreSQL, runs migrations, and starts the dev server

set -e

echo "🔧 Setting up Orplex Code in GitHub Codespaces..."
echo ""

# 1. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 2. Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# 3. Set up PostgreSQL
echo "🐘 Setting up PostgreSQL..."
if command -v psql &> /dev/null; then
    # PostgreSQL is available (devcontainer feature)
    PGPASSWORD=postgres psql -h localhost -U postgres -c "CREATE DATABASE orplex;" 2>/dev/null || echo "  Database 'orplex' already exists"
    
    # Update DATABASE_URL if not set
    if [ -z "$DATABASE_URL" ]; then
        export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/orplex"
        echo "export DATABASE_URL=\"$DATABASE_URL\"" >> ~/.bashrc
        echo "  Set DATABASE_URL=$DATABASE_URL"
    fi
else
    echo "  ⚠️  PostgreSQL not found. Add this to .devcontainer/devcontainer.json:"
    echo '  "features": { "ghcr.io/devcontainers/features/postgresql:1": { "version": "16" } }'
    echo ""
    echo "  Or set DATABASE_URL to your external database (Supabase, Neon, etc.)"
fi

# 4. Run database migrations
echo "🗄️  Running database migrations..."
npx prisma db push 2>/dev/null || echo "  ⚠️  db push failed — check DATABASE_URL"

# 5. Verify setup
echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Copy .env.example to .env and fill in your API keys"
echo "  2. Run: npm run dev"
echo "  3. Open the forwarded port (5000) in your browser"
echo ""
echo "🔑 Required API keys (in .env):"
echo "  - NVIDIA_API_KEY (free at build.nvidia.com)"
echo "  - NEXTAUTH_SECRET (run: openssl rand -base64 32)"
echo "  - DATABASE_URL (set above if using local PostgreSQL)"
echo ""
echo "🚀 Quick start:"
echo "  cp .env.example .env"
echo "  npm run dev"
echo ""
