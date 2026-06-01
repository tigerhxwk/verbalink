.PHONY: up down build logs restart

# Set LLM_BASE_URL in .env (e.g. LLM_BASE_URL=http://192.168.1.101:18080/v1)
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
