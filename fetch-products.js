import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

async function fetchProducts() {
  try {
    console.log('Fetching products from API...');
    
    // Fetch all products without filtering to get sport course types
    const productsUrl = `${API_URL}/products?join=tags&join=translations&join=linkedSubscriptions&limit=1000`;
    
    const response = await fetch(productsUrl);
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract only needed fields
    const products = data.data.map(product => ({
      id: product.id,
      description: product.description
    }));

    // Create products object with id as key for easy lookup
    const productsMap = {};
    products.forEach(prod => {
      productsMap[prod.id] = prod;
    });

    // Save to file
    const filePath = path.join(__dirname, 'products.json');
    fs.writeFileSync(filePath, JSON.stringify(productsMap, null, 2), 'utf8');
    
    console.log(`✅ Successfully saved ${products.length} products to products.json`);
    console.log(`Sample product:`, products[0]);
    
  } catch (error) {
    console.error('❌ Error fetching products:', error.message);
    process.exit(1);
  }
}

fetchProducts();
