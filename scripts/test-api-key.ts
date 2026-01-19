import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('❌ GEMINI_API_KEY not found in .env file');
  process.exit(1);
}

async function testAPIKey() {
  console.log('🔍 Testing Gemini API key...\n');
  console.log(`API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}\n`);
  
  // Try to list models using REST API
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error (${response.status}): ${response.statusText}`);
      console.error(`Response: ${errorText.substring(0, 500)}`);
      
      if (response.status === 401) {
        console.error('\n💡 Your API key appears to be invalid or expired.');
      } else if (response.status === 403) {
        console.error('\n💡 Your API key may not have permission to access Gemini API.');
        console.error('   Check: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
      }
      return;
    }
    
    const data = await response.json();
    
    if (data.models && data.models.length > 0) {
      console.log('✅ API key is valid! Available models:\n');
      const generateContentModels = data.models
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => m.name.replace('models/', ''));
      
      if (generateContentModels.length > 0) {
        console.log('Models that support generateContent:');
        generateContentModels.forEach((model: string) => {
          console.log(`  - ${model}`);
        });
        console.log(`\n💡 Recommended: Add this to your .env file:`);
        console.log(`   GEMINI_MODEL=${generateContentModels[0]}`);
      } else {
        console.log('⚠️  No models found that support generateContent');
        console.log('\nAll available models:');
        data.models.forEach((m: any) => {
          console.log(`  - ${m.name} (methods: ${m.supportedGenerationMethods?.join(', ') || 'none'})`);
        });
      }
    } else {
      console.log('⚠️  No models returned from API');
      console.log('Full response:', JSON.stringify(data, null, 2));
    }
    
  } catch (error: any) {
    console.error('❌ Error testing API:', error.message);
    console.error('\n💡 Possible issues:');
    console.error('   1. API key is invalid');
    console.error('   2. Network connectivity issue');
    console.error('   3. Gemini API is not enabled for your Google Cloud project');
  }
}

testAPIKey();
