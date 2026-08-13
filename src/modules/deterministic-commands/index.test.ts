/**
 * Deterministic-commands: resolveCommand + text_routes validation.
 *
 * Written RED-FIRST (2026-08-13): resolveCommand/validateTextRoutes did not
 * exist when this file landed. The text_routes mechanism lets an ALLOWED
 * sender's bare free-text message (e.g. a pure number) dispatch a configured
 * command with zero LLM — the caller's owner/allowlist guards run BEFORE any
 * of this, so the owner's free text is never routed (pinned by the caller's
 * early returns, not here).
 */
import { describe, expect, it } from 'vitest';

import { resolveCommand, validateTextRoutes } from './index.js';

const COMMANDS = {
  alpha: { exec: '/bin/true', args: ['run', '$1'], arg_re: '^[0-9]{1,4}( [0-9]{1,2}:[0-9]{2})?$' },
  beta: { exec: '/bin/true', args: ['other'] },
  help: { reply: 'static' },
};
const ROUTES = [{ re: '^[0-9]{1,4}( [0-9]{1,2}:[0-9]{2})?$', cmd: 'alpha' }];

describe('resolveCommand — slash semantics (today, byte-preserved)', () => {
  it('resolves /cmd arg', () => {
    expect(resolveCommand('/alpha 240', { commands: COMMANDS })).toEqual({
      cmd: 'alpha',
      arg: '240',
      via: 'slash',
    });
  });
  it('resolves /cmd@BotName arg', () => {
    expect(resolveCommand('/alpha@SomeBot 240', { commands: COMMANDS })).toEqual({
      cmd: 'alpha',
      arg: '240',
      via: 'slash',
    });
  });
  it('resolves a bare /cmd with empty arg', () => {
    expect(resolveCommand('/beta', { commands: COMMANDS })).toEqual({
      cmd: 'beta',
      arg: '',
      via: 'slash',
    });
  });
  it('resolves an UNKNOWN slash command (the caller refuses it — never the agent)', () => {
    expect(resolveCommand('/nope 1', { commands: COMMANDS })).toEqual({
      cmd: 'nope',
      arg: '1',
      via: 'slash',
    });
  });
});

describe('resolveCommand — text routes (bare free text, zero LLM)', () => {
  const cfg = { commands: COMMANDS, text_routes: ROUTES };
  it('routes a pure number', () => {
    expect(resolveCommand('208', cfg)).toEqual({ cmd: 'alpha', arg: '208', via: 'text_route' });
  });
  it('routes number + HH:MM (the timed form)', () => {
    expect(resolveCommand('208 03:15', cfg)).toEqual({
      cmd: 'alpha',
      arg: '208 03:15',
      via: 'text_route',
    });
  });
  it('trims before matching', () => {
    expect(resolveCommand('  208  ', cfg)).toEqual({ cmd: 'alpha', arg: '208', via: 'text_route' });
  });
  it.each(['208ml', 'oi', '38,5', 'obrigado 208', '12345', ''])(
    'does NOT route %j (free text stays on the agent lane)',
    (text) => {
      expect(resolveCommand(text, cfg)).toBeNull();
    },
  );
  it('without text_routes, non-slash text NEVER resolves (today, byte-preserved)', () => {
    expect(resolveCommand('208', { commands: COMMANDS })).toBeNull();
    expect(resolveCommand('208', { commands: COMMANDS, text_routes: [] })).toBeNull();
  });
  it('first matching route wins', () => {
    const two = {
      commands: COMMANDS,
      text_routes: [
        { re: '^[0-9]+$', cmd: 'alpha' },
        { re: '^[0-9]{1,4}$', cmd: 'beta' },
      ],
    };
    expect(resolveCommand('99', two)).toEqual({ cmd: 'alpha', arg: '99', via: 'text_route' });
  });
});

describe('validateTextRoutes — hard config validation (a broken route is a config error, never a 3am surprise)', () => {
  it('accepts absent and well-formed routes', () => {
    expect(() => validateTextRoutes(undefined, COMMANDS)).not.toThrow();
    expect(() => validateTextRoutes(ROUTES, COMMANDS)).not.toThrow();
  });
  it('rejects a non-array', () => {
    expect(() => validateTextRoutes({} as never, COMMANDS)).toThrow();
  });
  it('rejects an entry missing re or cmd', () => {
    expect(() => validateTextRoutes([{ re: '^x$' }] as never, COMMANDS)).toThrow();
    expect(() => validateTextRoutes([{ cmd: 'alpha' }] as never, COMMANDS)).toThrow();
  });
  it('rejects an invalid regex', () => {
    expect(() => validateTextRoutes([{ re: '([', cmd: 'alpha' }], COMMANDS)).toThrow();
  });
  it('rejects a route to a command that does not exist (orphan route)', () => {
    expect(() => validateTextRoutes([{ re: '^[0-9]+$', cmd: 'ghost' }], COMMANDS)).toThrow();
  });
});
