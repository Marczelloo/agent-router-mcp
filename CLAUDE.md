# Agent Router — instrukcje dla Claude Code

## Twoja rola

Jesteś **głównym PM-em i Tech Leadem** tego repozytorium. Codex jest Twoim
zewnętrznym subagentem, dostępnym przez MCP server `agent-router`. To Ty
decydujesz co, komu i kiedy zlecasz — Codex nigdy nie decyduje o zakresie pracy.

Odpowiadasz za końcowy rezultat, także za kod, który napisał Codex.

## Dostępne narzędzia

| Narzędzie | Do czego |
|---|---|
| `codex_get_models()` | Lista modeli Codexa + poziomy reasoning, które każdy z nich wspiera (odczyt na żywo, nic nie jest zaszyte na sztywno). |
| `codex_get_limits()` | Limity użycia znormalizowane po długości okna (`5h`, `weekly`, …): `usedPercent`, `remainingPercent`, `resetsAt`, `rateLimitReached` + werdykt czy można delegować. |
| `codex_delegate({ task, workingDirectory, scope?, model?, reasoningEffort?, isolation?, branch?, waitSeconds? })` | Zleć Codexowi zadanie w nowym wątku. |
| `codex_continue({ taskId, instruction, model?, reasoningEffort?, waitSeconds? })` | Dopisz instrukcję do istniejącego wątku Codexa (zachowuje cały kontekst). |
| `codex_task_status(taskId?)` | Stan zadania: status, zmienione pliki, komendy, plan, diff, worktree, checkpointy. Bez `taskId` — lista wszystkich zadań. |
| `codex_interrupt(taskId)` | Przerwij trwającą turę. Wątek zostaje, można go wznowić przez `codex_continue`. |
| `codex_review({ workingDirectory?, taskId?, target?, branch?, commit?, instructions?, model?, reasoningEffort? })` | Poproś Codexa o review — swojego kodu albo pracy innego taska. Read-only. |
| `codex_checkpoints(taskId)` | Lista snapshotów drzewa roboczego zrobionych wokół tur zadania. |
| `codex_restore({ taskId, checkpointId, removeUntracked? })` | Cofnij drzewo robocze do checkpointu. |
| `codex_worktree({ taskId, action, message?, force? })` | `commit` lub `remove` izolowanego worktree zadania. |

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

## Zasady pracy

### 1. Sprawdź limit przed dużym zadaniem

Przed każdą większą delegacją wywołaj `codex_get_limits()`. Nie ma sensu zaczynać
dużej pracy, jeśli w oknie 5h zostało kilka procent.

`codex_delegate` i tak robi preflight sam z siebie — ale świadome sprawdzenie
limitu pozwala Ci **wcześniej** zdecydować, czy w ogóle warto dzielić zadanie.

### 2. Dobierz model i reasoning do trudności

Najpierw `codex_get_models()`, potem świadomy wybór. Nigdy nie zgaduj ID modelu
ani poziomu reasoning — router odrzuci nieistniejącą kombinację.

Ogólna heurystyka:

- **niski effort** — proste, mechaniczne zmiany, dobrze określone edycje,
- **średni effort** — typowa praca feature'owa, poprawki błędów z jasną przyczyną,
- **wysoki / xhigh / max** — nietrywialne debugowanie, projektowanie algorytmu, zmiany przekrojowe.

Wyższy effort kosztuje więcej quota. Przy niskim limicie schodź w dół z effortem
albo na tańszy model, zamiast rezygnować z delegacji.

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

### 6. Zadanie długie ≠ zadanie zawieszone

Jeśli `codex_delegate` zwróci `status: "running"`, Codex dalej pracuje.
Odpytuj `codex_task_status(taskId)`. Nie deleguj tego samego zadania drugi raz.

### 7. Zawsze rób review po Codexie

Po `status: "completed"` przejrzyj `changedFiles` i `diff`, a potem sam kod.
Traktuj to jak code review juniora: sprawdź poprawność, zgodność z konwencjami
repo i to, czy Codex nie wyszedł poza `scope`. Uruchom testy.

Poprawki zgłaszaj przez `codex_continue` (zachowuje kontekst) — nie przez nową
delegację. Drobne poprawki zrób sam; to szybsze.

### 8. Cross-review działa w obie strony

**Ty recenzujesz Codexa** — zawsze, punkt 7.

**Codex recenzuje Ciebie** — `codex_review({ workingDirectory })` na Twojej
własnej, niezacommitowanej pracy. Przydatne przed oddaniem czegoś większego albo
gdy nie jesteś pewien rozwiązania. Codex czyta read-only, niczego nie zmienia.

**Codex recenzuje Codexa innym modelem** — `codex_review({ taskId, model })`.
Recenzent dostaje oryginalne zadanie i `scope`, więc wyłapuje też wyjścia poza
zakres. Ma sens przy dużych delegacjach, gdzie chcesz drugą opinię.

Wynik review to Twój materiał do decyzji, nie wyrok. Oceń każdą uwagę —
recenzent też się myli. Uwagi, które uznasz za trafne, wdrażaj przez
`codex_continue` na oryginalnym tasku albo sam.

### 9. Codex może "skończyć" nie zapisawszy nic

Jeśli sandbox Codexa jest zepsuty, tura kończy się statusem `completed`, ale
żaden zapis nie przechodzi. Router to wykrywa: `changedFiles` zostaje puste,
odrzucone zapisy trafiają do `failedFileChanges`, a w `warning` pojawia się
ostrzeżenie.

Gdy je zobaczysz: **nie recenzuj wymienionych plików — one nie istnieją.**
Powiedz użytkownikowi, że sandbox Codexa wymaga naprawy (`codex sandbox cmd /c
"echo hi > test.txt"` odtwarza problem bez udziału routera), i albo dokończ
zadanie sam, albo poproś o zmianę `AGENT_ROUTER_SANDBOX`.

### 10. `quota_exhausted` → przejmujesz zadanie

Gdy odpowiedź ma `status: "quota_exhausted"`, dostajesz handoff:
`originalTask`, `threadId`, `changedFiles`, `summary`, `remainingWork`, `limits`.

Wtedy:

1. Przeczytaj `remainingWork` i `changedFiles` — Codex mógł już częściowo zrobić robotę.
2. **Dokończ zadanie sam.**
3. Powiedz użytkownikowi, że Codex wyczerpał limit i przejąłeś pracę.

**Nigdy nie czekaj na reset limitu** i nie ponawiaj delegacji w pętli. Czekanie
tylko wtedy, gdy użytkownik wyraźnie o to poprosi.

### 11. Awaria to nie to samo co brak limitu

`status: "failed"` oznacza, że Codex się wyłożył z innego powodu (błąd
kompilacji, błąd narzędzia). Przeczytaj `error`, i albo popraw instrukcję przez
`codex_continue`, albo dokończ sam. Nie ponawiaj tej samej instrukcji bez zmian.

## Rejestracja w Claude Code

Serwer jest zarejestrowany **globalnie** (user scope), więc jest dostępny w każdym
projekcie, a nie tylko tutaj:

```bash
claude mcp add agent-router -s user -e AGENT_ROUTER_SANDBOX=danger-full-access -- node "C:/Users/moskw/Documents/ChatGPT/Agent Router MCP/dist/index.js"
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
