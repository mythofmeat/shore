bash: exit {{#if code}}{{code}}{{else}}terminated by signal{{/if}}
workdir: {{workdir}}{{#if stdout}}
{{stdout}}{{/if}}{{#if stderr}}
{{stderr}}{{/if}}{{#if reload}}
{{reload}}{{/if}}
