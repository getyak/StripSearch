import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom} from './dom-env.js';
import {renderHistory} from '../client/render.js';
import type {RunSummary} from '../shared/types.js';

test('history shortens URL labels while keeping the full accessible input and selected state', () => {
  const env=installDom();
  const container=env.document.createElement('div');
  const run:RunSummary={runId:'synthetic-history',question:'https://www.example.org/people/lin',state:'needs_input',provider:'research',revision:1,createdAt:'2026-10-22T00:00:00.000Z',updatedAt:'2026-10-22T00:00:00.000Z',sourceCount:0,reviewCount:0};
  const selected:string[]=[];
  renderHistory(container,[run],run.runId,id=>selected.push(id));
  const button=container.querySelector('button')!;
  assert.equal(button.querySelector('strong')!.textContent,'example.org/people/lin');
  assert.ok(button.getAttribute('aria-label')!.startsWith(run.question));
  assert.match(button.getAttribute('aria-label')!,/等待确认/);
  assert.equal(button.getAttribute('title'),run.question);
  assert.equal(button.getAttribute('aria-current'),'true');
  assert.doesNotMatch(button.querySelector('small')!.textContent!,/0 个来源/);
  button.click();assert.deepEqual(selected,[run.runId]);
  renderHistory(container,[{...run,question:'林舟的公开作品',sourceCount:4}],null,()=>{});
  assert.equal(container.querySelector('strong')!.textContent,'林舟的公开作品');
  assert.match(container.querySelector('small')!.textContent!,/4 个来源/);
  assert.match(container.querySelector('button')!.getAttribute('aria-label')!,/4 个来源/);
});

test('history preview compresses an embedded URL so URL plus prose stays readable', () => {
  const env=installDom();
  const container=env.document.createElement('div');
  const question='https://docs.google.com/document/d/1a%2Fb%2Fc%2Fd%2Fe%2Ff%2Fg%2Fh/edit?usp=sharing 这份提纲需要核对';
  const run:RunSummary={runId:'synthetic-history-url-prose',question,state:'completed',provider:'research',revision:1,createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',sourceCount:3,reviewCount:0};
  renderHistory(container,[run],null,()=>{});
  const button=container.querySelector('button')!;
  const preview=button.querySelector('strong')!.textContent!;
  assert.ok(preview.includes('docs.google.com'),preview);
  assert.ok(preview.includes('这份提纲需要核对'),preview);
  assert.ok(!preview.includes('%2F'),preview);
  assert.ok(!preview.includes('usp=sharing'),preview);
  assert.ok(preview.length<=121,preview);
  assert.equal(button.getAttribute('title'),question);
  assert.ok(button.getAttribute('aria-label')!.startsWith(question));
});
