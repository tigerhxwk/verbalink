.PHONY: up up-local down build logs restart

# Serverless: uses external LLM_BASE_URL (set in env or .env file)
up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

restart:
	docker compose restart $(s)
