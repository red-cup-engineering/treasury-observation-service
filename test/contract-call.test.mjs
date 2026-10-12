import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {CHAINS} from '../src/chains.mjs';
import {encoded} from '../src/contract-call.mjs';

const address='0x1111111111111111111111111111111111111111';
const reward='0x2222222222222222222222222222222222222222';
const tuple=new Interface(['function earned(address) view returns(address[],uint256[])']);
const scalar=new Interface(['function earned(address) view returns(uint256)']);
const result=tuple.encodeFunctionResult('earned',[[reward],[123456789n]]);
const fetchImpl=async()=>({ok:true,json:async()=>({result})});

test('a reward tuple cannot become a fictitious scalar amount equal to its ABI offset',async()=>{
  const wrong=await encoded(scalar,CHAINS.base,address,'earned',[address],{fetchImpl});
  assert.equal(wrong.ok,false);
  assert.match(wrong.reason,/complete canonical ABI result/);
  const correct=await encoded(tuple,CHAINS.base,address,'earned',[address],{fetchImpl});
  assert.equal(correct.ok,true);
  assert.deepEqual(Array.from(correct.value[0]),[reward]);
  assert.deepEqual(Array.from(correct.value[1]),[123456789n]);
});
