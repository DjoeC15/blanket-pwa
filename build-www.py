#!/usr/bin/env python3
"""Construit www/ (le webDir de Capacitor) à partir de pwa/, puis synchronise
les assets Android.

pwa/ est la version servie par HTTP, où les sons vivent dans
data/resources/sounds/. Dans l'APK ils sont embarqués à côté de l'app, donc
SOUND_PATH doit être réécrit — c'est la seule différence entre les deux, et
c'est exactement ce qu'une copie manuelle oublie.

Usage :  python build-www.py [--sync-android]
"""
import hashlib, os, re, shutil, sys

ROOT     = os.path.dirname(os.path.abspath(__file__))
PWA      = os.path.join(ROOT, 'pwa')
WWW      = os.path.join(ROOT, 'www')
SOUNDS   = os.path.join(ROOT, 'data', 'resources', 'sounds')
ASSETS   = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets')
ANDROID  = os.path.join(ASSETS, 'public')
CAP_CONF = os.path.join(ROOT, 'capacitor.config.json')

WEB_FILES = ['index.html', 'style.css', 'audio-engine.js', 'app.js',
             'manifest.json', 'sw.js']

SOUND_PATH_SRC = "const SOUND_PATH   = '../data/resources/sounds/';"
SOUND_PATH_APK = "const SOUND_PATH   = './sounds/';"


def build():
    os.makedirs(WWW, exist_ok=True)

    for name in WEB_FILES:
        src = os.path.join(PWA, name)
        if not os.path.exists(src):
            sys.exit(f'ERREUR: {src} introuvable')
        shutil.copy2(src, os.path.join(WWW, name))
    print(f'  {len(WEB_FILES)} fichiers web copiés')

    # Réécriture du chemin des sons
    app_js = os.path.join(WWW, 'app.js')
    code = open(app_js, encoding='utf-8').read()
    if SOUND_PATH_SRC not in code:
        if SOUND_PATH_APK in code:
            sys.exit('ERREUR: pwa/app.js contient déjà le chemin APK — '
                     'la source a été écrasée par une copie de www/')
        sys.exit('ERREUR: ligne SOUND_PATH introuvable dans pwa/app.js ; '
                 'mets à jour SOUND_PATH_SRC dans ce script')
    open(app_js, 'w', encoding='utf-8').write(code.replace(SOUND_PATH_SRC, SOUND_PATH_APK))
    print(f'  SOUND_PATH réécrit  -> ./sounds/')

    stamp_service_worker()

    # Icônes
    icons_src = os.path.join(PWA, 'icons')
    icons_dst = os.path.join(WWW, 'icons')
    if os.path.isdir(icons_dst):
        shutil.rmtree(icons_dst)
    shutil.copytree(icons_src, icons_dst)
    print(f'  icônes copiées      -> www/icons/ ({len(os.listdir(icons_dst))} fichiers)')

    # Reliquats d'anciennes copies manuelles à la racine de www/
    for stale in ('icon-192.png', 'icon-512.png'):
        p = os.path.join(WWW, stale)
        if os.path.exists(p):
            os.remove(p)
            print(f'  supprimé (obsolète) -> www/{stale}')

    # Sons
    dst_sounds = os.path.join(WWW, 'sounds')
    os.makedirs(dst_sounds, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(SOUNDS)):
        if f.endswith('.ogg'):
            shutil.copy2(os.path.join(SOUNDS, f), os.path.join(dst_sounds, f))
            n += 1
    print(f'  {n} sons copiés')


def stamp_service_worker():
    """Tamponne APP_CACHE avec un hash du contenu servi.

    sw.js applique une stratégie cache-first sans revalidation. Tant que le nom
    du cache ne change pas, l'appareil ressert l'ancien JS quoi qu'il arrive —
    un build peut alors sembler installé sans que la moindre ligne ne s'exécute.
    Le nom doit donc bouger dès que le contenu bouge.
    """
    digest = hashlib.sha256()
    for name in sorted(WEB_FILES):
        if name == 'sw.js':
            continue                      # évite de dépendre de son propre hash
        with open(os.path.join(WWW, name), 'rb') as f:
            digest.update(f.read())
    token = digest.hexdigest()[:12]

    sw = os.path.join(WWW, 'sw.js')
    code = open(sw, encoding='utf-8').read()
    code, n = re.subn(r"const APP_CACHE   = '[^']*';",
                      f"const APP_CACHE   = 'blanket-app-{token}';", code, count=1)
    if n != 1:
        sys.exit('ERREUR: ligne APP_CACHE introuvable dans sw.js')
    open(sw, 'w', encoding='utf-8').write(code)
    print(f'  cache SW tamponné   -> blanket-app-{token}')


def sync_android():
    os.makedirs(ASSETS, exist_ok=True)

    # Le .gitignore Capacitor exclut ces deux fichiers (normalement produits par
    # `cap sync`). Sans CLI installable ici, on les régénère : sinon un clone
    # frais donne un APK sans configuration, qui ne charge rien.
    shutil.copy2(CAP_CONF, os.path.join(ASSETS, 'capacitor.config.json'))
    with open(os.path.join(ASSETS, 'capacitor.plugins.json'), 'w', encoding='utf-8') as f:
        f.write('[]\n')          # aucun plugin Cordova : les nôtres sont natifs
    print('  configs Capacitor régénérées')

    if os.path.isdir(ANDROID):
        shutil.rmtree(ANDROID)
    shutil.copytree(WWW, ANDROID)

    # Capacitor attend ces deux fichiers dans public/ même sans plugin Cordova ;
    # il les génère vides. native-bridge.js, lui, est injecté au build par le
    # plugin Gradle depuis capacitor-android — ne pas le recréer ici.
    for stub in ('cordova.js', 'cordova_plugins.js'):
        open(os.path.join(ANDROID, stub), 'w').close()

    total = sum(len(files) for _, _, files in os.walk(ANDROID))
    print(f'  www/ -> android assets/public ({total} fichiers, dont 2 stubs Cordova)')


if __name__ == '__main__':
    print('build www/')
    build()
    if '--sync-android' in sys.argv:
        print('sync android')
        sync_android()
    print('OK')
