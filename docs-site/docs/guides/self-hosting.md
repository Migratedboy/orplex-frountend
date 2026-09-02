---
sidebar_position: 2
---

# Self-Hosting

## Prerequisites

- Docker or Podman
- 2GB RAM minimum
- Domain with HTTPS (for production)

## Quick Deploy

```bash
git clone https://github.com/orplex-tech/orplex-tech.git
cd orplex-tech
podman-compose up -d
```

## Environment Setup

1. Copy `.env.example` to `.env`
2. Set `DATABASE_URL` to your PostgreSQL instance
3. Set `NEXTAUTH_SECRET` to a random string
4. Set `NEXTAUTH_URL` to your domain
5. Add API keys for your preferred AI providers

## Production Checklist

- [ ] Set strong `NEXTAUTH_SECRET`
- [ ] Configure `ALLOWED_ORIGINS`
- [ ] Enable HTTPS
- [ ] Set up automated backups
- [ ] Configure monitoring
- [ ] Set resource limits in compose file

## Scaling

- Use connection pooling (PgBouncer)
- Add Redis for caching
- Use a reverse proxy (nginx/Caddy)
- Enable horizontal pod autoscaling
