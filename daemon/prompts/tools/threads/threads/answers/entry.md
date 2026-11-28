{{thread}}{{#if label}} "{{label}}"{{/if}}{{#if marks}} ({{marks}}){{/if}} · compaction {{#if compaction}}on{{else}}off{{/if}}{{#if purpose}}
  purpose: {{purpose}}{{/if}}{{#if pins}}
  pins: {{pins}}{{/if}}
  started by {{#if by_you}}you{{else}}{{user}}{{/if}} on {{started}}
  {{#if last}}{{user}} last wrote here {{last}}, {{length}} ago{{else}}{{user}} hasn't written here yet{{/if}}
