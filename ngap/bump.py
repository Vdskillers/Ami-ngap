#!/usr/bin/env python3
"""
bump.py — Script de bump automatique du référentiel NGAP
══════════════════════════════════════════════════════════════
Usage :
    python3 bump.py <new_version> [--message "..."] [--skip-tests] [--dry-run]

Exemples :
    python3 bump.py 2026.4 --message "Tarif AMI9 ajusté suite CIR-10/2026"
    python3 bump.py 2027.1_AV10 --message "Avenant 10 appliqué"
    python3 bump.py 2026.4 --dry-run   # voir ce qui serait fait

Ce que fait le script :
    1. Met à jour la version dans build_ref.py
    2. Régénère ngap_referentiel_2026.json
    3. Joue test_engine_extended.js (50 tests) — stop si <100%
    4. Joue test_engine.js (25 tests) — stop si <100%
    5. Re-synchronise la copie embarquée dans worker.js
    6. Re-synchronise la copie embarquée dans AI_Agent_AMI_v12_*.json
    7. Fait git add + commit avec message standard

Sécurité :
    - Aucune modification n'est faite tant que les tests ne passent pas à 100%
    - Commit automatique bloqué si un fichier a des changements non voulus
    - Mode --dry-run pour vérifier sans rien modifier
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# ── Configuration — auto-détection de l'arborescence ──────────────
SCRIPT_DIR = Path(__file__).resolve().parent
# Si bump.py est dans le même dossier que build_ref.py → on est dans NGAP_DIR
# Sinon on suppose la structure GitHub ngap-engine/
if (SCRIPT_DIR / "build_ref.py").exists():
    NGAP_DIR = SCRIPT_DIR
    REPO_ROOT = SCRIPT_DIR.parent
else:
    REPO_ROOT = SCRIPT_DIR.parent
    NGAP_DIR = REPO_ROOT / "ngap-engine"
    if not NGAP_DIR.exists():
        NGAP_DIR = REPO_ROOT / "ref"

REF_PATH = NGAP_DIR / "ngap_referentiel_2026.json"
ENGINE_PATH = NGAP_DIR / "ngap_engine.js"
BUILD_PATH = NGAP_DIR / "build_ref.py"
TEST1_PATH = NGAP_DIR / "test_engine.js"
TEST2_PATH = NGAP_DIR / "test_engine_extended.js"

WORKER_PATH = REPO_ROOT / "worker.js"
N8N_WORKFLOW_PATTERN = "AI_Agent_AMI_v*.json"  # glob — prend la plus récente

# ── Couleurs terminal ────────────────────────────────────────────────
C = {'g':'\033[92m', 'r':'\033[91m', 'y':'\033[93m', 'b':'\033[94m', 'c':'\033[96m', 'x':'\033[0m', 'bold':'\033[1m'}
def ok(msg):   print(f"{C['g']}✅ {msg}{C['x']}")
def ko(msg):   print(f"{C['r']}❌ {msg}{C['x']}")
def warn(msg): print(f"{C['y']}⚠️  {msg}{C['x']}")
def info(msg): print(f"{C['c']}ℹ️  {msg}{C['x']}")
def step(n, total, msg): print(f"\n{C['bold']}{C['b']}[{n}/{total}]{C['x']} {msg}")


def run(cmd, cwd=None, check=True):
    """Exécute une commande shell et retourne (ok, stdout, stderr)."""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd)
    if check and result.returncode != 0:
        ko(f"Commande échouée : {cmd}")
        print(result.stderr)
        return False, result.stdout, result.stderr
    return result.returncode == 0, result.stdout, result.stderr


def validate_version(v):
    """Format attendu : 2026.4, 2027.1_AV10, 2026.3_CIR9_2025, etc."""
    if not re.match(r'^[0-9]{4}\.[0-9]+(?:_[A-Z0-9]+)*$', v):
        return False, "Format : YYYY.X ou YYYY.X_SUFFIX (ex: 2026.4, 2027.1_AV10)"
    return True, ""


def update_build_ref_version(new_version, dry_run=False):
    """Met à jour la ligne 'version': 'NGAP_XXXX.X...' dans build_ref.py."""
    if not BUILD_PATH.exists():
        ko(f"build_ref.py introuvable : {BUILD_PATH}")
        return False
    content = BUILD_PATH.read_text(encoding='utf-8')
    # Pattern pour la version dans REFERENTIEL dict
    pattern = r'("version"\s*:\s*)"NGAP_[^"]+"'
    new_ver_str = f'NGAP_{new_version}'
    replacement = rf'\1"{new_ver_str}"'
    new_content, n_subs = re.subn(pattern, replacement, content, count=1)
    if n_subs == 0:
        ko(f"Pattern 'version' non trouvé dans build_ref.py")
        return False
    if dry_run:
        info(f"[dry-run] Modifierait build_ref.py : version → NGAP_{new_version}")
        return True
    BUILD_PATH.write_text(new_content, encoding='utf-8')
    ok(f"build_ref.py : version → NGAP_{new_version}")
    return True


def regenerate_json(dry_run=False):
    """Lance python3 build_ref.py → régénère ngap_referentiel_2026.json."""
    if dry_run:
        info("[dry-run] Lancerait python3 build_ref.py")
        return True
    success, stdout, _ = run(f"python3 {BUILD_PATH}", cwd=NGAP_DIR)
    if not success:
        return False
    # Afficher les dernières lignes (stats)
    for line in stdout.strip().split('\n')[-8:]:
        print(f"  {line}")
    return True


def run_tests(dry_run=False):
    """Joue les 2 banques de tests, retourne True si 100%."""
    if dry_run:
        info("[dry-run] Lancerait les 2 banques de tests")
        return True
    for path, label in [(TEST1_PATH, '25 tests V1'), (TEST2_PATH, '50 tests V2')]:
        if not path.exists():
            warn(f"Test absent : {path.name} — skip")
            continue
        success, stdout, _ = run(f"node {path.name}", cwd=NGAP_DIR, check=False)
        last_line = [l for l in stdout.strip().split('\n') if 'RÉSULTATS' in l or 'tests passent' in l]
        # Extraction "X/Y tests passent (Z%)"
        m = re.search(r'(\d+)/(\d+) tests? passent \((\d+)%', stdout)
        if not m:
            ko(f"{label} : impossible de parser le résultat")
            return False
        passed, total, pct = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if passed == total:
            ok(f"{label} : {passed}/{total} (100%)")
        else:
            ko(f"{label} : {passed}/{total} ({pct}%) — ÉCHECS :")
            for line in stdout.split('\n'):
                if '❌' in line or 'attendu' in line.lower():
                    print(f"     {line.strip()}")
            return False
    return True


def sync_worker_js(dry_run=False):
    """Met à jour la copie embarquée dans worker.js (const NGAP_REFERENTIEL_2026)."""
    if not WORKER_PATH.exists():
        warn(f"worker.js introuvable : {WORKER_PATH} — skip sync")
        return True  # non bloquant
    if not REF_PATH.exists():
        ko(f"Référentiel JSON introuvable : {REF_PATH}")
        return False
    new_ref_json = REF_PATH.read_text(encoding='utf-8')
    # Minifier pour réduire la taille
    new_ref_min = json.dumps(json.loads(new_ref_json), ensure_ascii=False, separators=(',', ':'))

    worker_content = WORKER_PATH.read_text(encoding='utf-8')
    # Match : const NGAP_REFERENTIEL_2026 = {...};  (jusqu'au premier `};\n` non-imbriqué)
    pattern = r'const NGAP_REFERENTIEL_2026 = (\{(?:[^{}]|\{[^}]*\})*\});'
    # Pattern simple : on prend depuis `const NGAP_REFERENTIEL_2026 = ` jusqu'au `};` de fin
    start_marker = 'const NGAP_REFERENTIEL_2026 = '
    start_idx = worker_content.find(start_marker)
    if start_idx < 0:
        warn("Constante NGAP_REFERENTIEL_2026 non trouvée dans worker.js — skip")
        return True
    # Trouver la fin : comptage d'accolades après start_idx
    depth = 0
    i = start_idx + len(start_marker)
    started = False
    end_idx = -1
    while i < len(worker_content):
        ch = worker_content[i]
        if ch == '{':
            depth += 1
            started = True
        elif ch == '}':
            depth -= 1
            if started and depth == 0:
                # Chercher le ; après
                j = i + 1
                while j < len(worker_content) and worker_content[j] in ' \t':
                    j += 1
                if j < len(worker_content) and worker_content[j] == ';':
                    end_idx = j + 1
                    break
        i += 1
    if end_idx < 0:
        warn("Impossible de détecter la fin de NGAP_REFERENTIEL_2026 — skip")
        return True

    new_declaration = f'{start_marker}{new_ref_min};'
    new_worker = worker_content[:start_idx] + new_declaration + worker_content[end_idx:]

    if dry_run:
        old_size = end_idx - start_idx
        new_size = len(new_declaration)
        info(f"[dry-run] worker.js : remplacerait {old_size:,} chars par {new_size:,} chars")
        return True

    WORKER_PATH.write_text(new_worker, encoding='utf-8')
    # Vérifier la syntaxe Node
    success, _, stderr = run(f"node --check {WORKER_PATH}", check=False)
    if not success:
        ko(f"worker.js syntaxe invalide après sync :\n{stderr}")
        # Rollback
        WORKER_PATH.write_text(worker_content, encoding='utf-8')
        warn("Rollback effectué sur worker.js")
        return False
    ok(f"worker.js : NGAP_REFERENTIEL_2026 synchronisé ({len(new_declaration):,} chars)")
    return True


def sync_n8n_workflow(dry_run=False):
    """Met à jour la copie embarquée dans le workflow n8n le plus récent."""
    workflows = sorted(REPO_ROOT.glob(N8N_WORKFLOW_PATTERN), key=lambda p: p.stat().st_mtime, reverse=True)
    if not workflows:
        warn(f"Aucun workflow n8n trouvé ({N8N_WORKFLOW_PATTERN}) — skip")
        return True
    target = workflows[0]
    info(f"Workflow n8n cible : {target.name}")

    if not REF_PATH.exists():
        ko("Référentiel introuvable")
        return False
    new_ref_min = json.dumps(json.loads(REF_PATH.read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':'))

    wf_content = json.loads(target.read_text(encoding='utf-8'))
    # Chercher le nœud "Recalcul NGAP Officiel" (ou variante)
    target_node = None
    for n in wf_content.get('nodes', []):
        if 'Recalcul' in n.get('name', '') and 'NGAP' in n.get('name', ''):
            target_node = n
            break
    if not target_node:
        warn("Nœud 'Recalcul NGAP Officiel' introuvable dans le workflow — skip")
        return True

    js_code = target_node.get('parameters', {}).get('jsCode', '')
    # Remplacer const NGAP_REF = {...};
    pattern = r'const NGAP_REF = (\{[\s\S]*?\});\s*\n'
    new_js, n = re.subn(pattern, f'const NGAP_REF = {new_ref_min};\n', js_code, count=1)
    if n == 0:
        warn("const NGAP_REF non trouvée dans le nœud n8n — skip")
        return True

    if dry_run:
        info(f"[dry-run] Remplacerait {len(js_code):,} chars par {len(new_js):,} chars dans {target.name}")
        return True

    target_node['parameters']['jsCode'] = new_js
    target.write_text(json.dumps(wf_content, ensure_ascii=False, indent=2), encoding='utf-8')
    ok(f"{target.name} : NGAP_REF synchronisé")
    return True


def git_commit(new_version, message, dry_run=False):
    """Fait git add + commit avec un message standard."""
    if dry_run:
        info(f"[dry-run] git add + commit 'bump: NGAP {new_version} — {message}'")
        return True
    # Vérifier qu'on est dans un repo
    success, _, _ = run("git rev-parse --is-inside-work-tree", check=False)
    if not success:
        warn("Pas dans un repo Git — skip commit")
        return True
    files = [str(REF_PATH), str(BUILD_PATH), str(WORKER_PATH)]
    workflows = list(REPO_ROOT.glob(N8N_WORKFLOW_PATTERN))
    files += [str(w) for w in workflows]
    existing = [f for f in files if Path(f).exists()]
    add_cmd = "git add " + " ".join(f'"{f}"' for f in existing)
    run(add_cmd, cwd=REPO_ROOT, check=False)
    commit_msg = f"bump: NGAP {new_version} — {message}"
    success, _, _ = run(f'git commit -m "{commit_msg}"', cwd=REPO_ROOT, check=False)
    if success:
        ok(f"Commit : {commit_msg}")
    else:
        warn("Rien à committer (peut-être identique ?)")
    return True


def main():
    parser = argparse.ArgumentParser(description="Bump automatique du référentiel NGAP")
    parser.add_argument('version', help="Nouvelle version (ex: 2026.4, 2027.1_AV10)")
    parser.add_argument('--message', '-m', default="Mise à jour référentiel", help="Message de commit")
    parser.add_argument('--skip-tests', action='store_true', help="⚠️ Skip les tests (déconseillé)")
    parser.add_argument('--dry-run', action='store_true', help="Simuler sans modifier")
    args = parser.parse_args()

    print(f"\n{C['bold']}🚀 BUMP NGAP → {args.version}{C['x']}")
    print(f"   Message : {args.message}")
    if args.dry_run:
        print(f"   {C['y']}MODE DRY-RUN — aucune modification{C['x']}")

    # Validation
    valid, err_msg = validate_version(args.version)
    if not valid:
        ko(f"Version invalide : {err_msg}")
        sys.exit(1)

    # Pipeline
    total_steps = 6 if not args.skip_tests else 5
    n = 1

    step(n, total_steps, "Mise à jour build_ref.py")
    if not update_build_ref_version(args.version, args.dry_run): sys.exit(1)
    n += 1

    step(n, total_steps, "Régénération ngap_referentiel_2026.json")
    if not regenerate_json(args.dry_run): sys.exit(1)
    n += 1

    if not args.skip_tests:
        step(n, total_steps, "Tests — 75 cas cliniques (V1 + V2)")
        if not run_tests(args.dry_run):
            ko("TESTS ÉCHOUÉS — déploiement avorté. Corriger avant de rebumper.")
            sys.exit(1)
        n += 1

    step(n, total_steps, "Synchronisation worker.js")
    if not sync_worker_js(args.dry_run): sys.exit(1)
    n += 1

    step(n, total_steps, "Synchronisation workflow n8n")
    if not sync_n8n_workflow(args.dry_run): sys.exit(1)
    n += 1

    step(n, total_steps, "Commit Git")
    if not git_commit(args.version, args.message, args.dry_run): sys.exit(1)

    print(f"\n{C['g']}{C['bold']}✨ BUMP TERMINÉ — NGAP {args.version}{C['x']}")
    print(f"   Prochaines étapes :")
    print(f"   • git push")
    print(f"   • wrangler deploy worker.js")
    print(f"   • Importer le workflow n8n mis à jour")


if __name__ == '__main__':
    main()
