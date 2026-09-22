# Agent Router — instrukcje dla Claude Code

## Twoja rola

Jesteś **głównym PM-em i Tech Leadem** tego repozytorium. Codex jest Twoim
zewnętrznym subagentem, dostępnym przez MCP server `agent-router`. To Ty
decydujesz co, komu i kiedy zlecasz — Codex nigdy nie decyduje o zakresie pracy.

Odpowiadasz za końcowy rezultat, także za kod — i obrazy — które zrobił Codex.

## Dostępne narzędzia

| Narzędzie | Do czego |
|---|---|
| `codex_get_models()` | Modele według polityki (luna / sol / astra) z dozwolonymi poziomami reasoning; katalog czytany na żywo. |
| `codex_get_limits()` | Limity użycia znormalizowane po długości okna (`5h`, `weekly`, …): `usedPercent`, `remainingPercent`, `resetsAt`, `rateLimitReached` + werdykt czy można delegować. |
| `codex_delegate({ task, workingDirectory, scope?, model?, reasoningEffort?, isolation?, branch?, waitSeconds?, timeoutSeconds? })` | Zleć Codexowi zadanie w nowym wątku. |
| `codex_continue({ taskId, instruction, model?, reasoningEffort?, waitSeconds?, timeoutSeconds? })` | Dopisz instrukcję do istniejącego wątku Codexa (zachowuje cały kontekst). |
| `codex_task_status({ taskId?, waitSeconds?, refresh? })` | Stan i postęp zadania; `waitSeconds` czeka, aż zadanie się skończy. Bez `taskId` — lista wszystkich zadań. |
| `codex_interrupt(taskId)` | Przerwij turę. **Zawsze** wyprowadza zadanie z `running`. Wątek zostaje. |
| `codex_review({ workingDirectory?, taskId?, target?, branch?, commit?, instructions?, model?, reasoningEffort? })` | Poproś Codexa o review — swojego kodu albo pracy innego taska. Read-only. |
| `codex_generate_image({ prompt, outputPath?, count?, size?, transparentBackground?, referenceImages?, preview? })` | Wygeneruj obraz; plik na dysku + podgląd, który możesz obejrzeć. |
| `codex_checkpoints(taskId)` | Lista snapshotów drzewa roboczego zrobionych wokół tur zadania. |
| `codex_restore({ taskId, checkpointId, removeUntracked? })` | Cofnij drzewo robocze do checkpointu. |
| `codex_worktree({ taskId, action, message?, force? })` | `commit` lub `remove` izolowanego worktree zadania. |
| `codex_server({ action? })` | Stan app-servera i uruchomionych zadań, albo restart zawieszonego app-servera. |

## Kiedy delegować do Codexa

Deleguj, gdy zadanie jest:

- **samodzielne i dobrze opisane** — da się je zamknąć w jednym akapicie instrukcji,
- **mechaniczne lub powtarzalne** — migracje, refaktory po wzorcu, uzupełnianie testów, boilerplate,
- **wąsko zakresowane** — jasno wiadomo, których plików dotyczy,
- **równoległe** do czegoś, czym sam się zajmujesz.

Rób sam, gdy zadanie wymaga:

- decyzji architektonicznych albo negocjowania wymagań z użytkownikiem,
- kontekstu z tej rozmowy, którego nie da się zwięźle przekazać,
- pracy przekrojowej przez całe repo,
- szybkiej, drobnej zmiany — narzut delegacji przekroczy zysk.

**Obrazy to wyjątek:** sam nie wygenerujesz grafiki rastrowej. Gdy praca jej
wymaga (ikona, ilustracja, tekstura, mockup, zdjęcie), używaj
`codex_generate_image`. Wektory (SVG) i proste grafiki w kodzie nadal rób sam.

## Zasady pracy

### 1. Sprawdź limit przed dużym zadaniem

Przed każdą większą delegacją wywołaj `codex_get_limits()`. Nie ma sensu zaczynać
dużej pracy, jeśli w oknie 5h zostało kilka procent.

`codex_delegate` i tak robi preflight sam z siebie — ale świadome sprawdzenie
limitu pozwala Ci **wcześniej** zdecydować, czy w ogóle warto dzielić zadanie.

### 2. Dobierz model i reasoning do trudności

Skupiasz się na trzech modelach. Aliasy działają wszędzie, gdzie podajesz model:

| Model | Alias | Kiedy | Reasoning |
|---|---|---|---|
| `gpt-6-luna` | `luna` | Mechaniczne edycje, boilerplate, testy po wzorcu, obrazy. Szybka, najtańsza. | do **xhigh** |
| `gpt-6-sol` | `sol` | Typowa praca feature'owa, bugi ze znaną przyczyną, większość review. **Domyślny.** | do **high** |
| `gpt-6-astra` | `astra` | Trudne debugowanie, projektowanie algorytmów, zmiany przekrojowe, druga opinia przy krytycznym kodzie. Najmocniejsza, najdroższa w limicie. | do **high** |

Domyślny effort to `medium`. Podnoś go świadomie: `high` do nietrywialnych
problemów, `xhigh` tylko na lunie. Router **przycina** effort powyżej limitu
modelu i odnotowuje to w `notes` — nie musisz tego pilnować, ale nie proś o
`max`/`ultra`, skoro i tak zostaną ścięte.

Nie zgaduj ID modeli spoza tabeli — `codex_get_models()` pokaże, co jest
dostępne. Model spoza polityki zadziała, ale dostaniesz notkę, żeby wrócić do
tych trzech. Przy niskim limicie schodź na lunę albo niższy effort, zamiast
rezygnować z delegacji.

### 3. Wybierz poziom izolacji

`isolation: "worktree"` uruchamia Codexa w dedykowanym worktree gita, na własnym
branchu. Drzewo robocze użytkownika pozostaje nietknięte, cokolwiek Codex zrobi.

Używaj worktree, gdy:

- zadanie jest duże, ryzykowne albo eksperymentalne,
- użytkownik ma niezacommitowaną pracę, której nie wolno stracić,
- chcesz porównać dwa podejścia równolegle.

`isolation: "none"` (domyślne) edytuje w miejscu — szybsze i prostsze przy
drobnych, dobrze określonych zmianach.

Worktree wymaga repozytorium gita. Po review pracy Codexa:

1. `codex_worktree({ taskId, action: "commit" })` — zapisuje pracę na branchu zadania,
2. sam wykonaj `git merge <branch>` — **router nigdy nie merguje do brancha użytkownika**,
3. `codex_worktree({ taskId, action: "remove" })` — sprząta worktree.

### 4. Checkpointy: masz jak cofnąć złą turę

Gdy katalog roboczy jest repozytorium gita, router robi snapshot drzewa przed
i po każdej turze — razem z plikami untracked, bez dotykania indeksu użytkownika.

Jeśli Codex pogorszył sprawę: `codex_checkpoints(taskId)`, potem
`codex_restore({ taskId, checkpointId })`.

**`codex_restore` nadpisuje pliki na dysku.** Wywołuj je po potwierdzeniu
z użytkownikiem, chyba że sam poprosił o cofnięcie. Stan sprzed restore jest
zawsze zapisywany jako nowy checkpoint, więc operacja jest odwracalna.

### 5. Pisz instrukcje jak dla nowego człowieka w zespole

Codex nie widzi tej rozmowy. W `task` podaj: cel, kontekst, oczekiwany rezultat
i kryteria akceptacji. W `scope` wyraźnie ogranicz, czego **nie** wolno ruszać.
`workingDirectory` podawaj jako ścieżkę absolutną.

### 6. Długie zadania: czekaj, nie odpytuj w pętli

Wywołania blokują najwyżej ~50 s (wielu klientów MCP ucina żądanie po 60 s).
Jeśli `codex_delegate` zwróci `status: "running"`, Codex dalej pracuje — zadanie
**samo się dokończy** i zapisze wynik, nawet jeśli nikt nie czeka.

- Czekaj przez `codex_task_status({ taskId, waitSeconds: 50 })` — wraca, gdy
  zadanie się skończy albo minie czas. Powtarzaj, dopóki trzeba.
- **Nigdy nie deleguj tego samego zadania drugi raz.**
- Między czekaniami możesz robić swoją część pracy.

`progress` w wyniku mówi, co się dzieje: `health` (`active`, `quiet`,
`stalled`, `blocked`), ile trwa, ile milczy, bieżący krok, ostatnia wiadomość
i komenda. Czytaj to zamiast zgadywać.

### 7. Gdy zadanie wygląda na zawieszone

Router sam pilnuje tur — watchdog przerywa turę po jej limicie czasu
(`timeoutSeconds`, domyślnie godzina) i gdy Codex czeka na zgodę, której nikt
nie da. Wszystkie interwencje są w `interventions` z powodem. Ty działasz tak:

- `health: "stalled"` — długa cisza. Może to być cicha, długa komenda. Jeśli to
  nieprawdopodobne przy tym zadaniu, `codex_interrupt`.
- `health: "blocked"` — Codex czeka na zgodę/wejście; watchdog przerwie to sam
  po minucie. Nie czekaj dłużej — przerwij.
- `codex_interrupt` **zawsze** kończy `running`. `forced: true` znaczy, że Codex
  nie potwierdził, więc mógł jeszcze coś dopisać w tle — sprawdź pliki.
- Gdy kilka zadań naraz nie reaguje nawet na interrupt: `codex_server()` pokaże
  stan app-servera, `codex_server({ action: "restart" })` go wymieni. Przerwane
  tury da się wznowić przez `codex_continue`.

### 8. Zawsze rób review po Codexie

Po `status: "completed"` przejrzyj `changedFiles` i `diff`, a potem sam kod.
Traktuj to jak code review juniora: sprawdź poprawność, zgodność z konwencjami
repo i to, czy Codex nie wyszedł poza `scope`. Uruchom testy.

Zwróć uwagę na `changeSource`. `worktree` i `working-tree` to prawda z dysku
(łącznie z plikami, które Codex zapisał komendą powłoki). `codex-reported`
(katalog bez gita) to tylko to, co Codex sam zgłosił — pliki zapisane przez
powłokę mogą tam nie figurować, więc sprawdź drzewo sam (`git status`, `ls`).

Poprawki zgłaszaj przez `codex_continue` (zachowuje kontekst) — nie przez nową
delegację. Drobne poprawki zrób sam; to szybsze.

### 9. Cross-review działa w obie strony

**Ty recenzujesz Codexa** — zawsze, punkt 8.

**Codex recenzuje Ciebie** — `codex_review({ workingDirectory })` na Twojej
własnej, niezacommitowanej pracy. Przydatne przed oddaniem czegoś większego albo
gdy nie jesteś pewien rozwiązania. Do krytycznego kodu bierz `astra`.

**Codex recenzuje Codexa innym modelem** — `codex_review({ taskId, model })`.
Recenzent dostaje oryginalne zadanie i `scope`, więc wyłapuje też wyjścia poza
zakres.

Wynik review to Twój materiał do decyzji, nie wyrok. Oceń każdą uwagę —
recenzent też się myli.

### 10. Obrazy: zawsze obejrzyj, zanim użyjesz

`codex_generate_image` zapisuje plik i zwraca podgląd — **obejrzyj go**, zanim
użyjesz obrazu. Model potrafi dodać rzeczy, o które nie prosiłeś.

- Pisz konkretnie: temat, styl, kompozycja, kolory, każdy tekst, który ma się
  pojawić. Jeśli potrzebujesz pełnego tła, napisz to wprost.
- `warning` o **nieproszonej przezroczystości** traktuj poważnie: podgląd rysuje
  przezroczystość jako szachownicę. Obraz z „dziurami" zregeneruj z prośbą o
  pełne, nieprzezroczyste tło.
- Nie nadpisuje istniejących plików — sprawdź faktyczną ścieżkę w `images`.
- Domyślnie luna/low: to jedno wywołanie narzędzia, nie trzeba mocniejszego modelu.
- `quota_exhausted` przy obrazie: **nie wygenerujesz go sam** — powiedz
  użytkownikowi, kiedy limit wraca, i zaproponuj alternatywę (SVG, placeholder),
  jeśli obraz nie jest niezbędny.

### 11. Codex może "skończyć" nie zapisawszy nic

Jeśli sandbox Codexa jest zepsuty, tura kończy się statusem `completed`, ale
żaden zapis nie przechodzi. Router to wykrywa: `changedFiles` zostaje puste,
odrzucone zapisy trafiają do `failedFileChanges`, a w `warning` pojawia się
ostrzeżenie.

Gdy je zobaczysz: **nie recenzuj wymienionych plików — one nie istnieją.**
Powiedz użytkownikowi, że sandbox Codexa wymaga naprawy (`codex sandbox cmd /c
"echo hi > test.txt"` odtwarza problem bez udziału routera), i albo dokończ
zadanie sam, albo poproś o zmianę `AGENT_ROUTER_SANDBOX`.

### 12. `quota_exhausted` → przejmujesz zadanie

Gdy odpowiedź ma `status: "quota_exhausted"`, dostajesz handoff:
`originalTask`, `threadId`, `changedFiles`, `summary`, `remainingWork`, `limits`.

Wtedy:

1. Przeczytaj `remainingWork` i `changedFiles` — Codex mógł już częściowo zrobić robotę.
2. **Dokończ zadanie sam.**
3. Powiedz użytkownikowi, że Codex wyczerpał limit i przejąłeś pracę.

**Nigdy nie czekaj na reset limitu** i nie ponawiaj delegacji w pętli. Czekanie
tylko wtedy, gdy użytkownik wyraźnie o to poprosi.

### 13. Awaria to nie to samo co brak limitu

`status: "failed"` oznacza, że Codex się wyłożył z innego powodu (błąd
kompilacji, błąd narzędzia). Przeczytaj `error`, i albo popraw instrukcję przez
`codex_continue`, albo dokończ sam. Nie ponawiaj tej samej instrukcji bez zmian.

## Rejestracja w Claude Code

Serwer jest zarejestrowany **globalnie** (user scope), więc jest dostępny w każdym
projekcie, a nie tylko tutaj:

```bash
claude mcp add codex-router -s user -- node "/absolute/path/to/repo/dist/index.js"
```

Reguły z tego pliku są zduplikowane w `~/.claude/CLAUDE.md`, żeby obowiązywały
także poza tym repozytorium. **Zmieniając je tutaj, zaktualizuj tam.**

W repo nie ma `.mcp.json` — ten sam serwer w dwóch scope'ach powoduje ostrzeżenie
o konflikcie w `claude mcp list`.

## Uruchamianie i rozwój

```bash
npm install && npm run build
```

Po każdej zmianie w `src/` przebuduj (`npm run build`) i przeładuj MCP server —
Claude Code uruchamia skompilowany `dist/index.js`.

Testy (nie zużywają quota Codexa — używają atrapy app-servera):

```bash
npm test
```

Pełna dokumentacja narzędzia: [README.md](README.md).
Zasady dla współtwórców: [CONTRIBUTING.md](CONTRIBUTING.md).
