# AMI RAG — Makefile
# Commandes courantes pour maintenir le corpus et les embeddings.
#
# Usage :
#   cd rag/
#   make install        # première fois : créer venv + installer fastembed
#   make build          # régénère les vecteurs depuis chunks.json
#   make patch          # injecte dans le workflow N8N (ajuster WF)
#   make stats          # statistiques corpus
#   make clean          # supprime venv + __pycache__

VENV     := .venv
PY       := $(VENV)/bin/python3
PIP      := $(VENV)/bin/pip

# Workflow cible pour --patch (le plus récent en prod)
WF       := ../n8n/AI_Agent_AMI_v12_HYBRID_RAG_v1.json
WF_OUT   := ../n8n/AI_Agent_AMI_v12_HYBRID_RAG_v2.json
NODE     := "RAG NGAP Retriever"

.PHONY: help install build patch stats clean reset

help:
	@echo "Commandes disponibles :"
	@echo "  make install    Créer le venv Python et installer fastembed"
	@echo "  make build      Régénérer rag_payload.json (cache incrémental par id)"
	@echo "  make patch      Injecter le payload dans le workflow N8N"
	@echo "  make stats      Afficher des stats sur le corpus"
	@echo "  make reset      Supprimer le cache et recalculer TOUT depuis zéro"
	@echo "  make clean      Supprimer venv + __pycache__"

install:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip >/dev/null
	$(PIP) install -r requirements.txt
	@echo "✅ Venv prêt dans $(VENV)"

build: $(VENV)
	$(PY) build_embeddings.py \
	    --chunks chunks.json \
	    --cache rag_payload.json \
	    --out rag_payload.json
	@echo "✅ rag_payload.json régénéré"

patch: $(VENV) build
	@test -f $(WF) || (echo "❌ Workflow introuvable : $(WF)"; exit 1)
	$(PY) build_embeddings.py \
	    --chunks chunks.json \
	    --cache rag_payload.json \
	    --workflow $(WF) \
	    --node-name $(NODE) \
	    --out $(WF_OUT)
	@echo ""
	@echo "✅ Workflow patché : $(WF_OUT)"
	@echo "   → Importe-le dans N8N (Settings > Import workflow)"

stats:
	@echo "── Corpus NGAP ──"
	@jq 'length' chunks.json | xargs -I{} echo "  Chunks    : {}"
	@jq '[.[] | .text | length] | add / length | floor' chunks.json | xargs -I{} echo "  Taille moy: {} caractères"
	@jq '[.[] | .id]' chunks.json | jq 'group_by(. | split("_")[1]) | map({pref: .[0] | split("_")[1], n: length}) | sort_by(.n) | reverse' | head -20
	@test -f rag_payload.json && echo "── Payload ──" && \
	    jq '.n, .dim, .model' rag_payload.json | paste -d' ' - - - | xargs -I{} echo "  n/dim/model: {}"

reset:
	rm -f rag_payload.json
	@echo "Cache supprimé — lancer 'make build' pour recalculer"

clean:
	rm -rf $(VENV) __pycache__ *.pyc

$(VENV):
	@echo "❌ Venv absent. Lance 'make install' d'abord." && exit 1
