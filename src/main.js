import { camelCase } from 'lodash-es';
import './style.css';
import data from './data.json';

console.log('Hello from Mini Vite');
console.log('camelCase:', camelCase('hello mini vite'));
console.log('JSON from ESM: ', data);
