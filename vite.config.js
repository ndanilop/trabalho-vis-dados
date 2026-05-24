// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  // Define que a pasta 'static' contém os arquivos públicos servidos na raiz
  publicDir: 'static', 
  
  // Opcional: Adiciona suporte para carregar arquivos .db como URLs se necessário futuramente,
  // similar ao import mostrado na Image 2 do professor.
  assetsInclude: ['**/*.db'],
});