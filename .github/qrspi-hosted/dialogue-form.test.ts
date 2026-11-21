import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dialogueQuestions} from './dialogue-form.ts';
import {protocol} from './documents.ts';
test('intake requires a direct answer and never treats a generic discuss click as answering',{skip:!process.env.GITHUB_ULTIMATE_ROOT},async()=>{
  const p=await protocol(process.env.GITHUB_ULTIMATE_ROOT!);
  const form=p.parseRecord(JSON.stringify({format:'standard',id:'intake-answer',task_id:'task-test',title:'Goals discussion',allowCodeFileChanges:false,questions:dialogueQuestions('What problem should we address?')}));
  assert.ok(p.validateAnswers(form,{decision:{discuss:true}}).length);
  assert.ok(p.validateAnswers(form,{answer:''}).length);
  assert.deepEqual(p.validateAnswers(form,{answer:'Yes, use the proposed framing.'}),[]);
  assert.deepEqual(p.validateAnswers(form,{answer:'I am unsure; please help narrow it down.'}),[]);
  const questions=dialogueQuestions('Choose the main problem',[{id:'problem',type:'choices',title:'Which problem matters most?',description:'Choose the primary impact to address.',choices:[{id:'lost_context',label:'Review feedback loses context',description:'Keep submitted feedback with the correct conversation.',is_recommended_reason:'Matches the observed handoff failure.',prosAndCons:{pros:['Preserves the reviewer’s intent'],cons:['Needs explicit response/run binding']}},{id:'recovery',label:'Failed handoffs are hard to recover'}]}]);
  const rich=p.parseRecord(JSON.stringify({...form,questions}));
  assert.deepEqual(p.validateAnswers(rich,{problem:{lost_context:true}}),[]);
  assert.ok(p.validateAnswers(rich,{}).length);
  assert.equal(rich.questions[0].choices[0].prosAndCons.pros[0],'Preserves the reviewer’s intent');
  for (const mode of ['atMostOne','exactlyOne']) {
    const grouped=p.parseRecord(JSON.stringify({...rich,questions:[{...rich.questions[0],choiceGroups:[{id:'suggested',mode,choiceIds:['lost_context','recovery']}]}]}));
    const answers={problem:{lost_context:true,recovery:true},problem_lost_context_more_info:'Keep the conversation binding.',problem_recovery_more_info:'Also preserve recovery.',problem_other_more_info:'A hybrid may help.',problem_more_info:'Combine these priorities.'};
    assert.deepEqual(p.validateAnswers(grouped,answers),[]);
    // Notes do not need a checked choice, and the dialogue adapter retains the
    // exact authored group and tradeoffs rather than converting them to radios.
    assert.deepEqual(p.validateAnswers(grouped,{problem:{lost_context:true},problem_recovery_more_info:'Not selecting this yet.'}),[]);
    assert.equal(grouped.questions[0].choiceGroups[0].mode,mode);
  }
  const optional=p.parseRecord(JSON.stringify({...form,questions:dialogueQuestions('Report any mismatch',[{id:'mismatch',type:'textarea',title:'What, if anything, is inaccurate?',description:'Leave blank if none.',required:false}])}));
  assert.equal(optional.questions[0].required,false);
  assert.deepEqual(p.validateAnswers(optional,{}),[]);
  assert.deepEqual(p.validateAnswers(optional,{mismatch:''}),[]);
  assert.throws(()=>dialogueQuestions('Question',[{id:'decision',type:'choices'}]),/reserved/);
  assert.throws(()=>dialogueQuestions('Question',[]),/one to six/);
});
