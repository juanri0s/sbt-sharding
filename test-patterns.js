const { glob } = require('glob');

async function test() {
  const testStar = await glob('test-fixtures/**/Test*.scala', { absolute: false });
  const starTest = await glob('test-fixtures/**/*Test.scala', { absolute: false });
  
  console.log('Test*.scala matches:', testStar.sort().join(', '));
  console.log('*Test.scala matches:', starTest.sort().join(', '));
  
  const onlyInTestStar = testStar.filter(f => !starTest.includes(f));
  const onlyInStarTest = starTest.filter(f => !testStar.includes(f));
  
  console.log('\nOnly in Test*.scala:', onlyInTestStar.join(', '));
  console.log('Only in *Test.scala:', onlyInStarTest.join(', '));
}

test().catch(console.error);
