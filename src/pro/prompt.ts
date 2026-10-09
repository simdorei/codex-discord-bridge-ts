import {requireDiscordText} from '../discord/text.ts';
/** is_pro_command iff rewrite_pro_prompt sees an ASCII-case-insensitive !pro
 * first word. This predicate does not rewrite a prompt or invoke another agent. */
export function isProCommand(prompt: string): boolean {
  requireDiscordText(prompt); const text = prompt.replace(/^\p{White_Space}+/u, '');
  const end = text.search(/\p{White_Space}/u), word = end < 0 ? text : text.slice(0, end);
  return word.replace(/[A-Z]/g, char => char.toLowerCase()) === '!pro';
}
