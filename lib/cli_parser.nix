{ lib, ... }:

let
  # -------------------------
  # String-context utilities
  # -------------------------

  # Merge two context attrsets.
  mergeCtx = a: b: a // b;

  # Collect (union) string context from a list of strings.
  collectCtxFromStrings =
    xs: builtins.foldl' mergeCtx { } (builtins.map builtins.getContext xs);

  # Attach to `piece` exactly those context elements whose keys occur as substrings in `piece`,
  # taking the candidate context from `originalString`.
  attachRelevantContext =
    originalString: piece:
    let
      ctx = builtins.getContext originalString;
      filtered = lib.filterAttrs (k: _v: lib.strings.hasInfix k piece) ctx;
    in
    builtins.appendContext piece filtered;

  # Same as above, but the source is any string that already has context (e.g. a token).
  attachRelevantContextFromSource =
    sourceWithContext: piece:
    let
      ctx = builtins.getContext sourceWithContext;
      filtered = lib.filterAttrs (k: _v: lib.strings.hasInfix k piece) ctx;
    in
    builtins.appendContext piece filtered;

  # Attach to `piece` ALL context from `sourceWithContext` (union), regardless of substrings.
  attachAllContextFromSource =
    sourceWithContext: piece:
    builtins.appendContext piece (builtins.getContext sourceWithContext);

  # -------------------------
  # Tokenizer: POSIX-ish shell quoting (subset)
  # - whitespace separates tokens
  # - supports single quotes '...'
  # - supports double quotes "..."
  # - supports backslash escaping outside quotes and inside double quotes
  # - no globbing, no var expansion, no pipes/redirection
  # -------------------------
  tokenizeShlex =
    s:
    let
      chars = lib.strings.stringToCharacters s;
      isWS = c: c == " " || c == "\t" || c == "\n" || c == "\r";

      # state = { mode = "normal"|"single"|"double"; esc = bool; cur = string; out = [string]; }
      step =
        state: c:
        let
          flush =
            st:
            if st.cur == "" then
              st
            else
              st
              // {
                out = st.out ++ [ st.cur ];
                cur = "";
              };

          add = st: ch: st // { cur = st.cur + ch; };
        in
        if state.esc then
          add (state // { esc = false; }) c
        else if state.mode == "normal" then
          if c == "\\" then
            state // { esc = true; }
          else if c == "'" then
            state // { mode = "single"; }
          else if c == "\"" then
            state // { mode = "double"; }
          else if isWS c then
            flush state
          else
            add state c
        else if state.mode == "single" then
          if c == "'" then state // { mode = "normal"; } else add state c
        # double
        else if c == "\\" then
          state // { esc = true; }
        else if c == "\"" then
          state // { mode = "normal"; }
        else
          add state c;

      final = builtins.foldl' step {
        mode = "normal";
        esc = false;
        cur = "";
        out = [ ];
      } chars;

      final2 =
        if final.mode != "normal" then
          throw "tokenizeShlex: unterminated quote"
        else if final.esc then
          throw "tokenizeShlex: dangling backslash escape"
        else
          final;

      tokensRaw =
        if final2.cur == "" then final2.out else final2.out ++ [ final2.cur ];

      # IMPORTANT: attach relevant context to each token
      tokens = builtins.map (t: attachRelevantContext s t) tokensRaw;
    in
    tokens;

  # -------------------------
  # Helpers
  # -------------------------
  startsWith =
    prefix: str: builtins.substring 0 (builtins.stringLength prefix) str == prefix;

  drop = n: str: builtins.substring n (builtins.stringLength str - n) str;

  addOpt =
    opts: k: v:
    let
      old = if builtins.hasAttr k opts then opts.${k} else [ ];
    in
    opts // { "${k}" = old ++ [ v ]; };

  sort = lib.sort (a: b: a < b);

  # Shell-quote a token so tokenizeShlex can read it back.
  # Uses single quotes, escaping internal single quotes with: '\'' (classic POSIX form).
  shellQuoteRaw =
    s:
    if s == "" then
      "''"
    else if builtins.match "^[A-Za-z0-9_@%+=:,./-]+$" s != null then
      s
    else
      let
        parts = builtins.split "(')" s;
        escPart = p: if p == "'" then "'\\''" else p;
      in
      "'" + (builtins.concatStringsSep "" (builtins.map escPart parts)) + "'";

  # Like shellQuoteRaw, but preserves relevant string context from the original token.
  shellQuote =
    tokenWithContext:
    let
      raw = shellQuoteRaw tokenWithContext;
      # Ensure the quoted representation carries any context implied by the token text.
      # (The store path text still appears inside quotes, so this remains correct.)
      withCtx = attachRelevantContextFromSource tokenWithContext raw;
    in
    withCtx;

  # -------------------------
  # Parser to canonical form (per your schema)
  # -------------------------
  parseCanonicalCliString =
    s:
    let
      argv = tokenizeShlex s;
      fail = msg: throw ("parseCanonicalCliString: " + msg);

      program =
        if argv == [ ] then fail "empty command string" else builtins.head argv;

      rest0 = builtins.tail argv;

      # subcommands: contiguous leading tokens that are not options/flags and not `--`
      parseSubcommands =
        xs:
        if xs == [ ] then
          {
            subs = [ ];
            rest = [ ];
          }
        else
          let
            a = builtins.head xs;
            tl = builtins.tail xs;
          in
          if a == "--" || startsWith "-" a then
            {
              subs = [ ];
              rest = xs;
            }
          else
            let
              r = parseSubcommands tl;
            in
            {
              subs = [ a ] ++ r.subs;
              rest = r.rest;
            };

      subParsed = parseSubcommands rest0;

      isFlagBundle = t: builtins.match "^-[A-Za-z]+$" t != null;

      # only --name=value; name restricted
      isLongKV = t: builtins.match "^--[A-Za-z0-9_.-]+=(.*)$" t != null;

      # expand -kvvv -> ["k" "v" "v" "v"]
      expandFlags =
        t:
        let
          body = drop 1 t;
          n = builtins.stringLength body;
        in
        builtins.genList (i: builtins.substring i 1 body) n;

      go =
        xs: endOfOpts: flags: opts: operands:
        if xs == [ ] then
          {
            flags = flags;
            options = opts;
            operands = operands;
          }
        else
          let
            a = builtins.head xs;
            tl = builtins.tail xs;
          in
          if endOfOpts then
            go tl true flags opts (operands ++ [ a ])
          else if a == "--" then
            go tl true flags opts operands
          else if builtins.match "^-[^-].*=.*$" a != null then
            # forbid -x=value and any other single-dash (or non --) with '='
            fail ("single-dash (or non --) option with '=' is not allowed: `" + a + "`")
          else if isLongKV a then
            let
              m = builtins.match "^--([A-Za-z0-9_.-]+)=(.*)$" a;
              nameRaw = builtins.elemAt m 0;
              valueRaw = builtins.elemAt m 1;

              key = "--" + nameRaw;

              # builtins.match groups lose context; reattach from the *token*.
              value = attachRelevantContextFromSource a valueRaw;
            in
            go tl false flags (addOpt opts key value) operands
          else if isFlagBundle a then
            go tl false (flags ++ (expandFlags a)) opts operands
          else
            fail (
              "unexpected token before `--`: `" + a + "` (operands only allowed after `--`)"
            );
      parsed = go subParsed.rest false [ ] { } [ ];

      flagsCanon = sort parsed.flags;
    in
    {
      program = program;
      subcommands = subParsed.subs; # order matters
      flags = flagsCanon; # sorted, duplicates preserved
      options = parsed.options; # "--k" -> [ v1 v2 ] (value order preserved)
      operands = parsed.operands; # order matters
    };

  # -------------------------
  # Canonical command string (round-trippable + preserves context)
  # -------------------------
  toCanonicalCommandString =
    canon:
    let
      flagTok =
        if canon.flags == [ ] then
          [ ]
        else
          # flags are letters, no context needed; still return plain string
          [ (builtins.concatStringsSep "" ([ "-" ] ++ canon.flags)) ];

      optToks = builtins.concatLists (
        builtins.map (
          k:
          let
            vs = canon.options.${k};
          in
          builtins.map (v: k + "=" + shellQuote v) vs
        ) (builtins.attrNames canon.options)
      );

      opToks =
        if canon.operands == [ ] then
          [ ]
        else
          [ "--" ] ++ (builtins.map shellQuote canon.operands);

      toks = [
        (shellQuote canon.program)
      ]
      ++ (builtins.map shellQuote canon.subcommands)
      ++ flagTok
      ++ optToks
      ++ opToks;

      cmdRaw = builtins.concatStringsSep " " toks;

      # Ensure the full canonical string carries all relevant context.
      ctx = collectCtxFromStrings toks;
    in
    builtins.appendContext cmdRaw ctx;

in
{
  inherit
    tokenizeShlex
    parseCanonicalCliString
    toCanonicalCommandString
    shellQuote
    attachRelevantContext
    attachRelevantContextFromSource
    attachAllContextFromSource
    ;
}
