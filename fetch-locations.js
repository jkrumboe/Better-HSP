import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = 'https://backbone-web-api.production.munster.delcom.nl';

async function fetchLocations() {
  try {
    console.log('Fetching locations from API...');
    const response = await fetch(`${API_URL}/locations`);
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract only needed fields
    const locations = data.data.map(location => ({
      id: location.id,
      siteId: location.siteId,
      description: location.description,
      latitude: location.latitude,
      longitude: location.longitude,
      zipCode: location.zipCode,
      street: location.street,
      streetNumber: location.streetNumber
    }));

    // Create locations object with id as key for easy lookup
    const locationsMap = {};
    locations.forEach(loc => {
      locationsMap[loc.id] = loc;
    });

    // Save to file
    const filePath = path.join(__dirname, 'locations.json');
    fs.writeFileSync(filePath, JSON.stringify(locationsMap, null, 2), 'utf8');
    
    console.log(`✅ Successfully saved ${locations.length} locations to locations.json`);
    console.log(`Sample location:`, locations[0]);
    
  } catch (error) {
    console.error('❌ Error fetching locations:', error.message);
    process.exit(1);
  }
}

fetchLocations();
