import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand} from './qrspi-comment.mjs';
test('only exact, bounded PR commands are accepted',()=>{
 assert.deepEqual(parseCommand('/qrspi start',12),{workflow:'qrspi-start.lock.yml',inputs:{workspace_id:'pr-12'}});
 assert.deepEqual(parseCommand('/qrspi resume 3 approve',12),{workflow:'qrspi-resume.lock.yml',inputs:{workspace_id:'pr-12',revision:'3',decision:'approve'}});
 for(const body of ['/qrspi resume 0 approve','/qrspi resume 1 merge','/qrspi start && echo evil','/qrspi resume 1 approve\n/qrspi start','/qrspi resume 9999999999 approve']){
   assert.equal(parseCommand(body,12),null);
 }
 assert.equal(parseCommand('/qrspi start',0),null);
});
