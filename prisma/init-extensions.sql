-- Initialize PostgreSQL extensions required by Orplex Tech
-- This runs automatically on first container startup

-- Enable pgvector for cosine similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
